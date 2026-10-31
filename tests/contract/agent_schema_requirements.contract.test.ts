import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTION_IO_SCHEMA_FILES,
  PLUG_AGENTE_SCHEMA_FILES,
  requiredPlugAgenteSchemas,
} from "../helpers/plug_agente_contract";

const roots: string[] = [];
function schemasFor(methods: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "agent-schema-contract-"));
  roots.push(root);
  const schemas = join(root, "schemas");
  mkdirSync(schemas);
  writeFileSync(
    join(root, "openrpc.json"),
    JSON.stringify({ methods: methods.map((name) => ({ name })) }),
  );
  return schemas;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("versioned agent schema requirements", () => {
  it("keeps legacy schemas mandatory without imposing unsupported I/O", () => {
    expect(requiredPlugAgenteSchemas(schemasFor(["agent.action.run", "sql.execute"]))).toEqual(
      PLUG_AGENTE_SCHEMA_FILES,
    );
    expect(PLUG_AGENTE_SCHEMA_FILES).toContain("rpc.params.agent-action-run.schema.json");
  });
  it.each(["sendInput", "closeInput", "getInputStatus", "readIo", "findExecution"])(
    "requires the complete I/O family when %s is declared even if files are absent",
    (method) => {
      expect(requiredPlugAgenteSchemas(schemasFor([`agent.action.${method}`]))).toEqual([
        ...PLUG_AGENTE_SCHEMA_FILES,
        ...ACTION_IO_SCHEMA_FILES,
      ]);
    },
  );
  it("does not silently accept a missing OpenRPC contract", () => {
    const schemas = schemasFor([]);
    rmSync(join(schemas, "..", "openrpc.json"));
    expect(() => requiredPlugAgenteSchemas(schemas)).toThrow();
  });
});
