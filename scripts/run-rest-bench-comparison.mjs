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
import { spawnSync } from "node:child_process";
import pg from "pg";
import {
  aggregateRestApiBenchReports,
  restApiBenchComparisonErrors,
  REST_BENCH_COMPARISON_SCHEDULE,
} from "../tests/performance/rest_api_bench_reports.ts";

// A fixed ABBA/BAAB schedule balances linear time drift. Every trial is retained;
// no adaptive retries, best-run selection, or threshold changes are permitted.
const schedule = REST_BENCH_COMPARISON_SCHEDULE;
const baseArg = process.argv.indexOf("--base");
if (baseArg < 0 || !process.argv[baseArg + 1]) throw new Error("Pass --base <prepared checkout>");
if (process.env.NODE_ENV !== "test" || process.env.REST_BENCH_ISOLATED_DATABASE !== "true") {
  throw new Error("REST comparison requires NODE_ENV=test and explicit isolated database opt-in");
}
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
const ledger = { schedule, fingerprints, trials: [], complete: false };
const saveLedger = () =>
  writeFileSync(path.join(output, "schedule.json"), JSON.stringify(ledger, null, 2));
saveLedger();
const adminUrl = new URL(template);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.href });
await admin.connect();
const runId = randomUUID().replaceAll("-", "");
try {
  for (const [index, label] of schedule.entries()) {
    const root = roots[label];
    const database = `bench_${runId}_${index}_test`;
    const url = new URL(template);
    url.pathname = `/${database}`;
    // Both identifiers are validated/generated above. Only databases created by
    // this invocation are dropped; the migrated template is never modified.
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${templateName}"`);
    try {
      const log = path.join(output, `${index}-${label}.log`);
      const descriptor = openSync(log, "w");
      const env = { ...process.env, DATABASE_URL: url.href };
      delete env.REST_API_BENCH_BASELINE_PATH;
      let result;
      const started = new Date().toISOString();
      try {
        result = spawnSync(
          process.execPath,
          [
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
            timeout: 240_000,
          },
        );
      } finally {
        closeSync(descriptor);
      }
      ledger.trials.push({ index, label, started, status: result.status, signal: result.signal });
      saveLedger();
      const reportFile = path.join(root, "tmp/rest-api-bench.json");
      const freshReport =
        existsSync(reportFile) && statSync(reportFile).mtimeMs >= Date.parse(started);
      if (freshReport)
        writeFileSync(path.join(output, `${index}-${label}.json`), readFileSync(reportFile));
      if (result.error || result.status !== 0)
        throw new Error(`REST trial ${index} (${label}) failed; inspect ${log}`, {
          cause: result.error,
        });
      if (!freshReport) throw new Error(`REST trial ${index} did not produce a fresh report`);
      const report = JSON.parse(readFileSync(reportFile, "utf8"));
      const errors = restApiBenchComparisonErrors(report);
      if (errors.length) throw new Error(errors.join("\n"));
      reports[label].push(report);
      console.log(
        `REST trial ${index + 1}/${schedule.length} (${label}) passed correctness checks`,
      );
    } finally {
      await admin.query(`DROP DATABASE "${database}"`);
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
