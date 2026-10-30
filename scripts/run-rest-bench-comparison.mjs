import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { cpus } from "node:os";
import { spawn } from "node:child_process";
import pg from "pg";
import {
  readRestBenchCpuAffinity,
  startRestBenchCoordinator,
} from "../tests/performance/rest_api_bench_coordination.ts";
import {
  aggregateRestApiBenchReports,
  restApiBenchComparisonErrors,
  restApiBenchVariability,
  REST_BENCH_COMPARISON_SCHEDULE,
} from "../tests/performance/rest_api_bench_reports.ts";

// Preserve the fixed four trials per revision, but pair workers and alternate
// individual repetitions. Whole-process ABBA ordering did not control abrupt
// host speed changes. Every sample and the original numerical limits are kept.
const schedule = REST_BENCH_COMPARISON_SCHEDULE;
const baseArg = process.argv.indexOf("--base");
if (baseArg < 0 || !process.argv[baseArg + 1]) throw new Error("Pass --base <prepared checkout>");
if (process.env.NODE_ENV !== "test" || process.env.REST_BENCH_ISOLATED_DATABASE !== "true") {
  throw new Error("REST comparison requires NODE_ENV=test and explicit isolated database opt-in");
}
if (process.env.REST_BENCH_ISOLATED_REDIS !== "true")
  throw new Error("REST comparison requires explicit isolated Redis opt-in");
const template = new URL(process.env.DATABASE_URL ?? "");
const templateName = decodeURIComponent(template.pathname.slice(1));
if (!/^[a-z][a-z0-9_]*_test$/.test(templateName))
  throw new Error("Template must be a dedicated *_test database");
const roots = { base: path.resolve(process.argv[baseArg + 1]), head: process.cwd() };
const output = path.resolve("tmp/rest-bench-comparison");
mkdirSync(output, { recursive: true });

const sourceFingerprint = (root) => {
  const hash = createHash("sha256");
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    if (statSync(absolute).isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else {
      hash.update(relative.replaceAll("\\", "/"));
      hash.update(readFileSync(absolute));
    }
  };
  for (const file of ["src", "package.json", "package-lock.json", "vitest.rest-perf.config.mjs"])
    visit(file);
  for (const file of readdirSync(path.join(root, "tests/performance"))
    .filter((name) => name.startsWith("rest_api_bench"))
    .sort()) {
    visit(path.join("tests/performance", file));
  }
  return hash.digest("hex");
};
const fingerprints = Object.fromEntries(
  Object.entries(roots).map(([label, root]) => [label, sourceFingerprint(root)]),
);
const reports = { base: [], head: [] };
const allowedCpus = readRestBenchCpuAffinity();
const selectedCpu = process.platform === "linux" ? Number(allowedCpus.match(/^\d+/)?.[0]) : null;
if (selectedCpu !== null && !Number.isSafeInteger(selectedCpu))
  throw new Error("Invalid benchmark CPU affinity");
// Both revisions inherit the same CPU, avoiding migration across unlike cores.
// The affinity is also read back from the actual Vitest worker into its report.
const cpuMask = selectedCpu === null ? null : (1n << BigInt(selectedCpu)).toString(16);
const ledger = {
  schedule,
  fingerprints,
  cpu: { model: cpus()[0]?.model, allowedCpus, selectedCpu },
  pairs: [],
  trials: [],
  complete: false,
};
const saveLedger = () =>
  writeFileSync(path.join(output, "schedule.json"), JSON.stringify(ledger, null, 2));
saveLedger();
const adminUrl = new URL(template);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.href });
await admin.connect();
const runId = randomUUID().replaceAll("-", "");
try {
  for (let pairStart = 0; pairStart < schedule.length; pairStart += 2) {
    const pair = schedule.slice(pairStart, pairStart + 2);
    const turn = await startRestBenchCoordinator(pair[0]);
    const pairRecord = { first: pair[0], turns: turn.coordinator.turns, complete: false };
    ledger.pairs.push(pairRecord);
    const databases = [];
    const pending = [];
    try {
      for (const [offset, label] of pair.entries()) {
        const index = pairStart + offset;
        const database = `bench_${runId}_${index}_test`;
        // Only validated/generated identifiers and databases owned by this invocation.
        await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${templateName}"`);
        databases.push(database);
        const url = new URL(template);
        url.pathname = `/${database}`;
        const env = { ...process.env, DATABASE_URL: url.href };
        // Simultaneously resident workers must not overwrite deterministic presence
        // keys or idempotency state. The opted-in Redis service is test-only.
        for (const name of [
          "AGENT_HUB_PRESENCE_REDIS_URL",
          "REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL",
        ]) {
          const redis = new URL(process.env[name] ?? "");
          redis.pathname = `/${index + 1}`;
          env[name] = redis.href;
        }
        const reportFile = path.join(output, `${index}-${label}.json`);
        env.REST_API_BENCH_REPORT_PATH = reportFile;
        env.REST_BENCH_COORDINATOR_URL = turn.url;
        env.REST_BENCH_COORDINATOR_TOKEN = turn.token;
        env.REST_BENCH_COORDINATOR_LABEL = label;
        delete env.REST_API_BENCH_BASELINE_PATH;
        const root = roots[label];
        const log = path.join(output, `${index}-${label}.log`);
        const descriptor = openSync(log, "w");
        const started = new Date().toISOString();
        const child = spawn(
          cpuMask === null ? process.execPath : "taskset",
          [
            ...(cpuMask === null ? [] : [cpuMask, process.execPath]),
            "--expose-gc",
            "node_modules/vitest/vitest.mjs",
            "run",
            "--config",
            "vitest.rest-perf.config.mjs",
          ],
          {
            cwd: root,
            env,
            stdio: ["ignore", descriptor, descriptor],
          },
        );
        closeSync(descriptor);
        const trial = (async () => {
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
          }, 240_000);
          const result = await new Promise((resolve) => {
            child.once("error", (error) => resolve({ status: null, error }));
            child.once("exit", (status, signal) => resolve({ status, signal }));
          });
          clearTimeout(timer);
          ledger.trials.push({
            index,
            label,
            started,
            status: result.status,
            signal: result.signal,
            timedOut,
          });
          saveLedger();
          if (result.error || result.status !== 0 || timedOut)
            throw new Error(`REST trial ${index} (${label}) failed; inspect ${log}`, {
              cause: result.error,
            });
          if (!existsSync(reportFile) || statSync(reportFile).mtimeMs < Date.parse(started))
            throw new Error(`REST trial ${index} did not produce a fresh report`);
          const report = JSON.parse(readFileSync(reportFile, "utf8"));
          if (selectedCpu !== null && report.config.cpuAffinity !== String(selectedCpu))
            throw new Error(`REST trial ${index} did not inherit the required CPU affinity`);
          const errors = restApiBenchComparisonErrors(report);
          if (errors.length) throw new Error(errors.join("\n"));
          reports[label].push(report);
          console.log(
            `REST trial ${index + 1}/${schedule.length} (${label}) passed correctness checks`,
          );
        })();
        // Observe early startup failure even while the second database is being cloned.
        void trial.catch((error) => turn.coordinator.abort(error));
        pending.push(trial);
      }
      await Promise.all(pending);
      if (!turn.coordinator.completed)
        throw new Error("REST workers did not complete the paired schedule");
    } finally {
      await turn.close();
      await Promise.allSettled(pending);
      pairRecord.complete = turn.coordinator.completed;
      saveLedger();
      for (const database of databases) await admin.query(`DROP DATABASE "${database}"`);
    }
  }
} finally {
  await admin.end();
}
for (const [label, root] of Object.entries(roots)) {
  if (sourceFingerprint(root) !== fingerprints[label])
    throw new Error(`Sources changed during measurement: ${label}`);
}
const base = aggregateRestApiBenchReports(reports.base);
const head = aggregateRestApiBenchReports(reports.head);
const variability = { base: restApiBenchVariability(base), head: restApiBenchVariability(head) };
writeFileSync(path.join(output, "variability.json"), JSON.stringify(variability, null, 2));
console.log("REST p95 variability (all trials retained):", JSON.stringify(variability));
writeFileSync(path.join(output, "base.json"), JSON.stringify(base, null, 2));
writeFileSync(path.join(output, "head.json"), JSON.stringify(head, null, 2));
writeFileSync("tmp/rest-api-bench.json", JSON.stringify(head, null, 2));
ledger.complete = true;
const errors = restApiBenchComparisonErrors(head, base);
ledger.passed = errors.length === 0;
ledger.errors = errors;
saveLedger();
if (errors.length) throw new Error(`REST comparison failed:\n${errors.join("\n")}`);
console.log("REST balanced comparison passed all unchanged regression limits");
