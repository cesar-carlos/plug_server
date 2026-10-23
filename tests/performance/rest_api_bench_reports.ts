import { createHash } from "node:crypto";

import type { RestApiBenchReport, ScenarioResult } from "./rest_api_bench_harness";

export const REST_BENCH_COMPARISON_SCHEDULE = [
  "base",
  "head",
  "head",
  "base",
  "head",
  "base",
  "base",
  "head",
] as const;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

const hasCompleteLatencyTree = (
  scenario: ScenarioResult,
  iterations: number,
  groups: readonly number[],
): boolean => {
  const expected = groups.reduce((total, count) => total * count, iterations);
  if (
    !Number.isSafeInteger(expected) ||
    expected <= 0 ||
    !Array.isArray(scenario.latencySamplesMs) ||
    scenario.latencySamplesMs.length !== expected ||
    !scenario.latencySamplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)
  )
    return false;
  if (groups.length === 0) return !scenario.repetitions?.length;
  const repetitions = scenario.repetitions;
  if (
    !repetitions ||
    repetitions.length !== groups[0] ||
    !repetitions.every((child) => hasCompleteLatencyTree(child, iterations, groups.slice(1)))
  )
    return false;
  const flattened = repetitions.flatMap((child) => child.latencySamplesMs);
  return flattened.every((sample, index) => sample === scenario.latencySamplesMs[index]);
};

const hasCompleteLatencySamples = (
  report: RestApiBenchReport,
  scenario: ScenarioResult,
): boolean => {
  const iterations =
    report.config.scenarioProfiles?.[scenario.name]?.iterations ?? report.config.iterations;
  const groups =
    report.config.comparisonTrials === undefined
      ? [report.config.repeats]
      : [report.config.comparisonTrials, report.config.repeats];
  return hasCompleteLatencyTree(scenario, iterations, groups);
};

/** All fixed-schedule trials contribute; never select the fastest or retry a failing trial. */
export const aggregateRestApiBenchReports = (
  reports: readonly RestApiBenchReport[],
): RestApiBenchReport => {
  if (reports.length !== 4)
    throw new Error("REST comparison requires exactly four trials per revision");
  const first = reports[0]!;
  for (const report of reports) {
    if (
      report.harnessVersion !== first.harnessVersion ||
      report.configFingerprint !== first.configFingerprint ||
      JSON.stringify(report.config) !== JSON.stringify(first.config) ||
      JSON.stringify(report.versions) !== JSON.stringify(first.versions) ||
      report.nodeVersion !== first.nodeVersion ||
      report.platform !== first.platform ||
      JSON.stringify(report.scenarios.map((scenario) => scenario.name)) !==
        JSON.stringify(first.scenarios.map((scenario) => scenario.name))
    ) {
      throw new Error("REST trials must use the same harness, configuration and scenarios");
    }
    if (report.scenarios.some((scenario) => !hasCompleteLatencySamples(report, scenario)))
      throw new Error("REST trials must retain every latency sample");
  }
  const config = { ...first.config, comparisonTrials: reports.length };
  return {
    ...first,
    config,
    configFingerprint: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    scenarios: first.scenarios.map((scenario, index): ScenarioResult => {
      const trials = reports.map((report) => report.scenarios[index]!);
      if (trials.some((trial) => trial.responseDigest !== scenario.responseDigest)) {
        throw new Error(`REST response changed between trials: ${scenario.name}`);
      }
      return {
        ...scenario,
        repetitions: trials,
        latencySamplesMs: trials.flatMap((trial) => trial.latencySamplesMs),
        p50Ms: median(trials.map((trial) => trial.p50Ms)),
        p95Ms: median(trials.map((trial) => trial.p95Ms)),
        p99Ms: median(trials.map((trial) => trial.p99Ms)),
        throughputPerSec: median(trials.map((trial) => trial.throughputPerSec)),
        heapGrowthBytes: median(trials.map((trial) => trial.heapGrowthBytes)),
        retainedHeapGrowthBytes: median(trials.map((trial) => trial.retainedHeapGrowthBytes)),
        heapStartBytes: median(trials.map((trial) => trial.heapStartBytes)),
        heapAfterGcBytes: median(trials.map((trial) => trial.heapAfterGcBytes)),
        rssPeakBytes: Math.max(...trials.map((trial) => trial.rssPeakBytes)),
        cpuUserMs: median(trials.map((trial) => trial.cpuUserMs)),
        cpuSystemMs: median(trials.map((trial) => trial.cpuSystemMs)),
        eventLoopDelayP95Ms: median(trials.map((trial) => trial.eventLoopDelayP95Ms)),
        sqlQueries: median(trials.map((trial) => trial.sqlQueries)),
        redisCommands: median(trials.map((trial) => trial.redisCommands)),
        refreshWaitMs: median(trials.map((trial) => trial.refreshWaitMs)),
        refreshWaitingPeak: Math.max(...trials.map((trial) => trial.refreshWaitingPeak)),
        peakActiveRpcs: Math.max(...trials.map((trial) => trial.peakActiveRpcs)),
        errors: trials.reduce((sum, trial) => sum + trial.errors, 0),
        timeouts: trials.reduce((sum, trial) => sum + trial.timeouts, 0),
      };
    }),
  };
};

/** The original regression limits apply unchanged to individual or aggregated reports. */
export const restApiBenchComparisonErrors = (
  report: RestApiBenchReport,
  baseline?: RestApiBenchReport,
): string[] => {
  const errors: string[] = [];
  for (const scenario of report.scenarios) {
    if (!hasCompleteLatencySamples(report, scenario))
      errors.push(`${scenario.name}: missing or invalid latency samples`);
    if (scenario.errors !== 0) errors.push(`${scenario.name}: response errors`);
    if (scenario.timeouts !== 0) errors.push(`${scenario.name}: timeouts`);
  }
  if (
    createHash("sha256").update(JSON.stringify(report.config)).digest("hex") !==
    report.configFingerprint
  ) {
    errors.push("Invalid configuration fingerprint");
  }
  if (!baseline) return errors;
  for (const key of ["harnessVersion", "configFingerprint", "nodeVersion", "platform"] as const) {
    if (JSON.stringify(report[key]) !== JSON.stringify(baseline[key]))
      errors.push(`Mismatched ${key}`);
  }
  // Prisma is part of the candidate being measured, so dependency upgrades may
  // differ across revisions. Retain its reported version and require it to stay
  // identical within each revision's four trials (aggregateRestApiBenchReports).
  // External services must remain identical across both revisions.
  for (const key of ["postgres", "redis"] as const) {
    if (report.versions[key] !== baseline.versions[key]) errors.push(`Mismatched versions.${key}`);
  }
  if (
    JSON.stringify(report.scenarios.map((scenario) => scenario.name)) !==
    JSON.stringify(baseline.scenarios.map((scenario) => scenario.name))
  ) {
    return [...errors, "Mismatched scenarios"];
  }
  for (const [index, scenario] of report.scenarios.entries()) {
    const reference = baseline.scenarios[index]!;
    if (scenario.responseDigest !== reference.responseDigest)
      errors.push(`${scenario.name}: response changed`);
    if (scenario.name === "refresh_saturated") continue;
    if (!(scenario.p95Ms <= reference.p95Ms * 1.05))
      errors.push(`${scenario.name}: p95 ${scenario.p95Ms} > ${reference.p95Ms * 1.05}`);
    if (!(scenario.throughputPerSec >= reference.throughputPerSec * 0.85))
      errors.push(
        `${scenario.name}: throughput ${scenario.throughputPerSec} < ${reference.throughputPerSec * 0.85}`,
      );
    if (!(scenario.heapGrowthBytes <= reference.heapGrowthBytes * 1.1))
      errors.push(
        `${scenario.name}: heap ${scenario.heapGrowthBytes} > ${reference.heapGrowthBytes * 1.1}`,
      );
  }
  return errors;
};
