const fs = require("node:fs");
const path = require("node:path");

const summaryPath = path.resolve(process.cwd(), "coverage", "coverage-summary.json");

if (!fs.existsSync(summaryPath)) {
  console.error(`coverage summary not found: ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

const targets = [
  {
    path: "src/application/services/auth.service.ts",
    thresholds: { lines: 88, statements: 88, functions: 90, branches: 79 },
  },
  {
    path: "src/application/services/client_auth.service.ts",
    thresholds: { lines: 88, statements: 88, functions: 90, branches: 79 },
  },
  {
    path: "src/application/services/client_agent_access.service.ts",
    thresholds: { lines: 88, statements: 88, functions: 90, branches: 79 },
  },
  {
    path: "src/domain/policies/client_registration_status.policy.ts",
    thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
  },
  {
    path: "src/domain/policies/client_agent_access_request.policy.ts",
    thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
  },
  {
    path: "src/domain/policies/user_registration_status.policy.ts",
    thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
  },
];

const findEntry = (target) => {
  const normalizedTarget = target.replaceAll("\\", "/");
  return Object.entries(summary).find(([key]) => key.replaceAll("\\", "/").endsWith(normalizedTarget));
};

const failures = [];

for (const target of targets) {
  const entry = findEntry(target.path);
  if (!entry) {
    failures.push(`${target.path}: missing from coverage summary`);
    continue;
  }
  const [, metrics] = entry;
  for (const [metric, minimum] of Object.entries(target.thresholds)) {
    const pct = metrics?.[metric]?.pct;
    if (typeof pct !== "number" || Number.isNaN(pct)) {
      failures.push(`${target.path}: missing metric ${metric}`);
      continue;
    }
    if (pct < minimum) {
      failures.push(`${target.path}: ${metric} ${pct}% < ${minimum}%`);
    }
  }
}

if (failures.length > 0) {
  console.error("Critical coverage check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Critical coverage check passed.");
