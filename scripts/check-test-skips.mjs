import { readFileSync } from "node:fs";

// Every optional suite has an owning execution stage; new skips require an explicit decision.
const owners = {
  "tests/contract/columnar_agent.contract.test.ts": "Dart contract matrix",
  "tests/contract/plug_agente_optional.contract.test.ts": "Dart contract matrix",
  "tests/contract/socket_agent_inbound_fixtures.contract.test.ts": "Dart contract matrix",
  "tests/integration/agent_dart_socket_bridge.integration.test.ts": "Dart contract matrix",
  "tests/integration/sql_operation_dart_transport.integration.test.ts": "Dart main SQL transport/recovery step",
  "tests/integration/sql_operation_dart_recovery.integration.test.ts": "Dart main SQL transport/recovery step",
  "tests/integration/desktop_bootstrap.integration.test.ts": "Native agent fixtures (Windows)",
  "tests/integration/configured_desktop_bootstrap.integration.test.ts": "Native agent fixtures (Windows)",
  "tests/integration/infrastructure/repositories/rest_read_projections.integration.test.ts": "PostgreSQL read projections step",
  "tests/integration/redis_chaos.integration.test.ts": "Isolated Redis disconnect/recovery step",
};
const report = JSON.parse(readFileSync(process.argv[2] ?? "tmp/test-results.json", "utf8"));
if (!Array.isArray(report.testResults) || report.testResults.length === 0)
  throw new Error("Missing test results; cannot audit skipped tests");
let unexpected = 0;
for (const suite of report.testResults) {
  const name = suite.name.replaceAll("\\", "/");
  const path = Object.keys(owners).find((entry) => name === entry || name.endsWith(`/${entry}`));
  for (const test of suite.assertionResults) {
    if (!["pending", "skipped", "todo", "disabled"].includes(test.status)) continue;
    if (!path || test.status === "todo") {
      console.error(`Unexpected ${test.status}: ${name}: ${test.fullName}`);
      unexpected++;
    } else {
      console.log(`Skipped: ${test.fullName} — covered by ${owners[path]}`);
    }
  }
}
if (unexpected) throw new Error(`${unexpected} test skips have no execution owner`);
