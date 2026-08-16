const fs = require("node:fs");
const path = require("node:path");

const summaryPath = path.resolve(process.cwd(), "coverage", "coverage-summary.json");

if (!fs.existsSync(summaryPath)) {
  console.error(`coverage summary not found: ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

const APPLICATION_THRESHOLDS = { lines: 88, statements: 88, functions: 90, branches: 79 };
const POLICY_THRESHOLDS = { lines: 100, statements: 100, functions: 100, branches: 100 };

/**
 * Critical files for auth + client→agent access. Paths follow the post-split
 * services: session auth, registration/account, and request/decision/query.
 */
const targets = [
  { path: "src/application/services/auth.service.ts", thresholds: APPLICATION_THRESHOLDS },
  {
    path: "src/application/services/user_registration.service.ts",
    thresholds: APPLICATION_THRESHOLDS,
  },
  { path: "src/application/services/user_account.service.ts", thresholds: APPLICATION_THRESHOLDS },
  { path: "src/application/services/client_auth.service.ts", thresholds: APPLICATION_THRESHOLDS },
  {
    path: "src/application/services/client_agent_access_request.service.ts",
    thresholds: APPLICATION_THRESHOLDS,
  },
  {
    path: "src/application/services/client_agent_access_decision.service.ts",
    thresholds: APPLICATION_THRESHOLDS,
  },
  {
    path: "src/application/services/client_agent_access_query.service.ts",
    thresholds: APPLICATION_THRESHOLDS,
  },
  {
    path: "src/domain/policies/client_registration_status.policy.ts",
    thresholds: POLICY_THRESHOLDS,
  },
  {
    path: "src/domain/policies/client_agent_access_request.policy.ts",
    thresholds: POLICY_THRESHOLDS,
  },
  {
    path: "src/domain/policies/user_registration_status.policy.ts",
    thresholds: POLICY_THRESHOLDS,
  },
];

const findEntry = (target) => {
  const normalizedTarget = target.replaceAll("\\", "/");
  return Object.entries(summary).find(([key]) =>
    key.replaceAll("\\", "/").endsWith(normalizedTarget),
  );
};

const formatPct = (value) => (typeof value === "number" ? `${value.toFixed(2)}%` : "n/a");

const failures = [];
const report = [];

for (const target of targets) {
  const entry = findEntry(target.path);
  if (!entry) {
    failures.push(`${target.path}: missing from coverage summary`);
    report.push(`FAIL  ${target.path}: missing from coverage summary`);
    continue;
  }
  const [, metrics] = entry;
  const parts = [];
  let failed = false;
  for (const [metric, minimum] of Object.entries(target.thresholds)) {
    const pct = metrics?.[metric]?.pct;
    parts.push(`${metric} ${formatPct(pct)}/${minimum}%`);
    if (typeof pct !== "number" || Number.isNaN(pct)) {
      failures.push(`${target.path}: missing metric ${metric}`);
      failed = true;
      continue;
    }
    if (pct < minimum) {
      failures.push(`${target.path}: ${metric} ${pct}% < ${minimum}%`);
      failed = true;
    }
  }
  report.push(`${failed ? "FAIL" : "PASS"}  ${target.path}: ${parts.join("  ")}`);
}

console.log("Critical coverage:");
for (const line of report) {
  console.log(`  ${line}`);
}

if (failures.length > 0) {
  console.error("Critical coverage check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Critical coverage check passed.");
