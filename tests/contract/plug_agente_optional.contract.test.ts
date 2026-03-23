import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { agentCommandBodySchema, bridgeCommandSchema } from "../../src/shared/validators/agent_command";

const SCHEMA_FILES = [
  "rpc.request.schema.json",
  "rpc.response.schema.json",
  "rpc.error.schema.json",
  "rpc.batch.request.schema.json",
  "rpc.batch.response.schema.json",
  "rpc.params.sql-execute.schema.json",
  "rpc.params.sql-execute-batch.schema.json",
  "rpc.params.sql-cancel.schema.json",
  "rpc.result.sql-execute.schema.json",
  "rpc.result.sql-execute-batch.schema.json",
  "rpc.stream.chunk.schema.json",
  "rpc.stream.complete.schema.json",
  "rpc.stream.pull.schema.json",
  "payload-frame.schema.json",
  "agent.register.schema.json",
  "agent.capabilities.schema.json",
] as const;

function resolvePlugAgenteRoot(): string | null {
  const env = process.env.PLUG_AGENTE_ROOT?.trim();
  const candidates = [
    env,
    join(process.cwd(), "..", "plug_agente"),
    "D:/Developer/plug_database/plug_agente",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  for (const root of candidates) {
    const openrpc = join(root, "docs", "communication", "openrpc.json");
    if (existsSync(openrpc)) {
      return root;
    }
  }
  return null;
}

const plugAgenteRoot = resolvePlugAgenteRoot();
const openRpcPath =
  plugAgenteRoot !== null ? join(plugAgenteRoot, "docs", "communication", "openrpc.json") : "";
const schemasDir =
  plugAgenteRoot !== null ? join(plugAgenteRoot, "docs", "communication", "schemas") : "";

const contractDescribe = plugAgenteRoot !== null ? describe : describe.skip;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function withId(schema: Record<string, unknown>, $id: string): Record<string, unknown> {
  return { ...schema, $id };
}

/**
 * Registers plug_agente JSON Schemas. Relative `$ref` in the repo use `*.schema.json` filenames
 * while canonical `$id` URIs use `*.v1.json`; Ajv resolves refs from the parent path of `$id`.
 */
function registerPlugAgenteSchemas(ajv: InstanceType<typeof Ajv2020>): void {
  const read = (name: string): Record<string, unknown> => readJson(join(schemasDir, name));

  const error = read("rpc.error.schema.json");
  ajv.addSchema(error);
  ajv.addSchema(withId(error, "https://plugagente.dev/schemas/rpc.error.schema.json"));

  const request = read("rpc.request.schema.json");
  ajv.addSchema(request);
  ajv.addSchema(withId(request, "https://plugagente.dev/schemas/rpc.request.schema.json"));

  const response = read("rpc.response.schema.json");
  ajv.addSchema(response);
  ajv.addSchema(withId(response, "https://plugagente.dev/schemas/rpc.response.schema.json"));

  ajv.addSchema(read("rpc.batch.request.schema.json"));
  ajv.addSchema(read("rpc.batch.response.schema.json"));

  for (const name of SCHEMA_FILES) {
    if (
      name.startsWith("rpc.error") ||
      name.startsWith("rpc.request") ||
      name.startsWith("rpc.response") ||
      name === "rpc.batch.request.schema.json" ||
      name === "rpc.batch.response.schema.json"
    ) {
      continue;
    }
    ajv.addSchema(read(name));
  }
}

function assertZodAcceptsCommand(command: unknown): void {
  const asBody = { agentId: "contract-test-agent", command };
  const bodyParsed = agentCommandBodySchema.safeParse(asBody);
  expect(bodyParsed.success, JSON.stringify(bodyParsed.success ? null : bodyParsed.error.issues)).toBe(
    true,
  );

  const bridgeParsed = bridgeCommandSchema.safeParse(command);
  expect(
    bridgeParsed.success,
    JSON.stringify(bridgeParsed.success ? null : bridgeParsed.error.issues),
  ).toBe(true);
}

contractDescribe("plug_agente contract (OpenRPC + JSON Schema vs hub Zod)", () => {
  it("exposes expected OpenRPC methods and a parsable semver-like version", () => {
    const raw = readFileSync(openRpcPath, "utf8");
    const doc = JSON.parse(raw) as {
      methods?: { name: string }[];
      info?: { version?: string };
    };
    const names = new Set((doc.methods ?? []).map((m) => m.name));
    expect(names.has("sql.execute")).toBe(true);
    expect(names.has("sql.executeBatch")).toBe(true);
    expect(names.has("sql.cancel")).toBe(true);
    expect(names.has("rpc.discover")).toBe(true);

    const version = doc.info?.version;
    expect(typeof version).toBe("string");
    const parts = String(version).split(".").map((p) => Number.parseInt(p, 10));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(parts[0])).toBe(true);
    expect(Number.isFinite(parts[1])).toBe(true);
    const pack = (parts[0] ?? 0) * 1000 + (parts[1] ?? 0);
    expect(pack).toBeGreaterThanOrEqual(2005);
  });

  it("includes all published schema files under docs/communication/schemas", () => {
    for (const name of SCHEMA_FILES) {
      const p = join(schemasDir, name);
      expect(existsSync(p), `missing schema ${name}`).toBe(true);
    }
  });

  it("compiles JSON Schemas and accepts representative payloads; Zod accepts the same commands", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    registerPlugAgenteSchemas(ajv);

    const validateSqlExecuteParams = ajv.getSchema("https://plugagente.dev/schemas/rpc.params.sql-execute.v1.json");
    const validateSqlBatchParams = ajv.getSchema(
      "https://plugagente.dev/schemas/rpc.params.sql-execute-batch.v1.json",
    );
    const validateSqlCancelParams = ajv.getSchema("https://plugagente.dev/schemas/rpc.params.sql-cancel.v1.json");
    const validateRpcRequest = ajv.getSchema("https://plugagente.dev/schemas/rpc.request.v1.json");
    const validatePayloadFrame = ajv.getSchema("https://plugagente.dev/schemas/payload-frame.v1.json");
    const validateSqlResult = ajv.getSchema("https://plugagente.dev/schemas/rpc.result.sql-execute.v1.json");
    const validateBatchRequest = ajv.getSchema("https://plugagente.dev/schemas/rpc.batch.request.v1.json");
    const validateBatchResponse = ajv.getSchema("https://plugagente.dev/schemas/rpc.batch.response.v1.json");

    expect(validateSqlExecuteParams).toBeDefined();
    expect(validateSqlBatchParams).toBeDefined();
    expect(validateSqlCancelParams).toBeDefined();
    expect(validateRpcRequest).toBeDefined();
    expect(validatePayloadFrame).toBeDefined();
    expect(validateSqlResult).toBeDefined();
    expect(validateBatchRequest).toBeDefined();
    expect(validateBatchResponse).toBeDefined();

    const sqlParams = {
      sql: "SELECT 1",
      client_token: "a1b2c3d4",
      options: { timeout_ms: 30000, max_rows: 1000, execution_mode: "managed" as const },
    };
    expect(validateSqlExecuteParams!(sqlParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "contract-sql-1",
      params: sqlParams,
    });

    const sqlParamsPreserve = {
      sql: "SELECT * FROM t LIMIT 1",
      client_token: "a1b2c3d4",
      options: { execution_mode: "preserve" as const },
    };
    expect(validateSqlExecuteParams!(sqlParamsPreserve)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "contract-sql-preserve",
      params: sqlParamsPreserve,
    });

    const batchParams = {
      client_token: "a1b2c3d4",
      commands: [
        { sql: "SELECT 1", execution_order: 1 },
        { sql: "SELECT 2" },
      ],
      options: { transaction: false, timeout_ms: 10000 },
    };
    expect(validateSqlBatchParams!(batchParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.executeBatch",
      id: "contract-batch-1",
      params: batchParams,
    });

    const cancelParams = { execution_id: "exec-1", request_id: "req-1" };
    expect(validateSqlCancelParams!(cancelParams)).toBe(true);
    assertZodAcceptsCommand({
      jsonrpc: "2.0",
      method: "sql.cancel",
      id: "contract-cancel-1",
      params: cancelParams,
    });

    const rpcReq = {
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "rpc-meta",
      api_version: "2.5",
      meta: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        outbound_compression: "auto",
      },
      params: {},
    };
    expect(validateRpcRequest!(rpcReq)).toBe(true);

    const logicalJson = JSON.stringify({ ok: true });
    const payloadBytes = Array.from(Buffer.from(logicalJson, "utf8"));
    const frame = {
      schemaVersion: "1.0",
      enc: "json",
      cmp: "none",
      contentType: "application/json",
      originalSize: payloadBytes.length,
      compressedSize: payloadBytes.length,
      payload: payloadBytes,
      traceId: "trace-contract",
      requestId: "req-contract",
    };
    expect(validatePayloadFrame!(frame)).toBe(true);

    const sqlResult = {
      execution_id: "exec-contract",
      started_at: "2026-03-23T10:00:00.000Z",
      finished_at: "2026-03-23T10:00:01.000Z",
      rows: [{ "1": 1 }],
      row_count: 1,
      sql_handling_mode: "managed",
      max_rows_handling: "response_truncation",
      effective_max_rows: 50000,
    };
    expect(validateSqlResult!(sqlResult)).toBe(true);

    const batchRpc: unknown[] = [
      { jsonrpc: "2.0", method: "sql.execute", id: "b1", params: { sql: "SELECT 1" } },
      { jsonrpc: "2.0", method: "sql.execute", id: "b2", params: { sql: "SELECT 2" } },
    ];
    expect(validateBatchRequest!(batchRpc)).toBe(true);

    const batchRes: unknown[] = [
      {
        jsonrpc: "2.0",
        id: "b1",
        result: {
          execution_id: "e1",
          started_at: "2026-03-23T10:00:00.000Z",
          finished_at: "2026-03-23T10:00:00.001Z",
          rows: [],
          row_count: 0,
        },
      },
      {
        jsonrpc: "2.0",
        id: "b2",
        result: {
          execution_id: "e2",
          started_at: "2026-03-23T10:00:00.000Z",
          finished_at: "2026-03-23T10:00:00.001Z",
          rows: [],
          row_count: 0,
        },
      },
    ];
    expect(validateBatchResponse!(batchRes)).toBe(true);
  });

  it("rejects invalid sql.execute options per plug_agente schema (preserve + page)", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    registerPlugAgenteSchemas(ajv);
    const validateSqlExecuteParams = ajv.getSchema("https://plugagente.dev/schemas/rpc.params.sql-execute.v1.json");
    const bad = {
      sql: "SELECT 1",
      options: { execution_mode: "preserve", page: 1, page_size: 10 },
    };
    expect(validateSqlExecuteParams!(bad)).toBe(false);

    const z = bridgeCommandSchema.safeParse({
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "bad-preserve-page",
      params: bad,
    });
    expect(z.success).toBe(false);
  });
});
