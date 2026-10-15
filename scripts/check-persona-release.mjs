import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../contracts/persona-v2-release.json", import.meta.url), "utf8"),
);
// Keep the required acceptance contract in code as well as in the manifest.
// Removing or renaming a gate in JSON must never authorize a partial release.
const requiredGates = [
  "shared-knowledge-and-compatibility",
  "identity-and-authorization",
  "training-and-local-query",
  "federation",
  "agent-operation-journal",
  "hub-operation-contract",
  "operation-approval-and-reconciliation",
  "external-rest-and-mcp",
  "oauth-and-console",
  "postgres-real",
  "mssql-real",
  "sybase-real",
  "coordinated-cutover",
];
const complete =
  manifest.generation === "persona-v2" &&
  manifest.ready === true &&
  Array.isArray(manifest.requiredGates) &&
  manifest.requiredGates.length === requiredGates.length &&
  requiredGates.every((gate) => manifest.requiredGates.includes(gate)) &&
  Array.isArray(manifest.completedGates) &&
  manifest.requiredGates.every((gate) => manifest.completedGates.includes(gate));

if (!complete) {
  console.error("Publicação bloqueada: refatoração persona-v2 ainda sem aceite completo.");
  process.exitCode = 1;
}
