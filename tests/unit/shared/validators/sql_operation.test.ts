import { describe, expect, it } from "vitest";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";
import {
  computeBridgeWaitTimeoutMs,
  normalizeCommandForAgent,
} from "../../../../src/application/agent_commands/command_transformers";
import { sqlOperationExecuteParamsSchema } from "../../../../src/shared/validators/sql_operation";
import { buildSwaggerSpec } from "../../../../src/presentation/docs/swagger";

const params = (): typeof fixtureParams => structuredClone(fixtureParams);
const fixtureParams = {
  contractVersion: 1 as const,
  operationId: "11111111-1111-4111-8111-111111111111",
  fingerprint: "a".repeat(64),
  sourcePhysicalId: "b".repeat(64),
  database: "ephemeral",
  client_token: "fixture-token",
  timeoutMs: 60000,
  maxAffectedRows: 2,
  steps: [
    {
      id: "insert",
      effect: "insert" as const,
      sql: "INSERT INTO synthetic(name) VALUES (:name) RETURNING id",
      params: {
        name: { kind: "value" as const, scalar: { type: "string" as const, value: "fixture" } },
      },
      outputs: { id: "integer" as const },
      affectedRows: { min: 1, max: 1 },
    },
    {
      id: "detail",
      effect: "insert" as const,
      sql: "INSERT INTO synthetic_lines(order_id) VALUES (:id)",
      params: { id: { kind: "step_output" as const, stepId: "insert", output: "id" } },
      outputs: {},
      affectedRows: { min: 1, max: 1 },
    },
  ],
};
const command = (): {
  jsonrpc: "2.0";
  method: "sql.operation.execute";
  id: string;
  params: typeof fixtureParams;
} => ({
  jsonrpc: "2.0" as const,
  method: "sql.operation.execute" as const,
  id: "fixture",
  params: params(),
});
describe("versioned SQL operation transport", () => {
  it("preserves structural expectation, requires identity and refuses unproven metadata", () => {
    const expectedStructure = {
      version: 1,
      resources: [
        {
          resource: { schema: "public", name: "synthetic", type: "table" },
          columns: [{ name: "id", nativeType: "int4", nullable: false, size: 32, scale: 0 }],
        },
      ],
    };
    const expectedSource = { version: 1, dialect: "postgres", identityHash: "a".repeat(64) };
    const value = { ...params(), expectedStructure, expectedSource };
    const parsed = bridgeSingleCommandSchema.parse({ ...command(), params: value });
    expect(normalizeCommandForAgent(parsed)).toEqual(parsed);
    expect(
      sqlOperationExecuteParamsSchema.safeParse({ ...params(), expectedStructure }).success,
    ).toBe(false);
    expect(
      sqlOperationExecuteParamsSchema.safeParse({
        ...value,
        expectedStructure: {
          ...expectedStructure,
          resources: [
            {
              ...expectedStructure.resources[0],
              columns: [{ ...expectedStructure.resources[0]!.columns[0], nullable: null }],
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      sqlOperationExecuteParamsSchema.safeParse({
        ...value,
        expectedStructure: {
          ...expectedStructure,
          resources: [
            {
              ...expectedStructure.resources[0],
              constraints: {
                primaryKeys: [{ name: "pk", columns: ["id"], status: "unknown" }],
                uniqueKeys: [],
                foreignKeys: [],
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it("accepts typed output bindings and preserves SQL without rewriting", () => {
    const parsed = bridgeSingleCommandSchema.parse(command());
    expect(normalizeCommandForAgent(parsed)).toEqual(parsed);
    expect(computeBridgeWaitTimeoutMs(parsed)).toBe(65000);
    expect(computeBridgeWaitTimeoutMs([parsed])).toBe(65000);
  });
  it.each(["sql.operation.get", "sql.operation.cancel"])("accepts stable %s identity", (method) => {
    const { steps: _steps, maxAffectedRows: _max, timeoutMs: _timeout, ...reference } = params();
    expect(
      bridgeSingleCommandSchema.safeParse({ method, id: "request", params: reference }).success,
    ).toBe(true);
    expect(
      bridgeSingleCommandSchema.safeParse({ method, id: null, params: reference }).success,
    ).toBe(false);
  });
  it("requires bounds on each mutation and does not accept DDL as an effect", () => {
    const value = params();
    delete (value.steps[0] as { affectedRows?: unknown }).affectedRows;
    expect(sqlOperationExecuteParamsSchema.safeParse(value).success).toBe(false);
    expect(
      sqlOperationExecuteParamsSchema.safeParse({
        ...params(),
        steps: [{ ...params().steps[0], effect: "ddl" }],
      }).success,
    ).toBe(false);
  });
  it.each([
    (p: ReturnType<typeof params>) => ({ ...p, contractVersion: 2 }),
    (p: ReturnType<typeof params>) => ({ ...p, approved: true }),
    (p: ReturnType<typeof params>) => ({ ...p, steps: [p.steps[1], p.steps[0]] }),
    (p: ReturnType<typeof params>) => ({ ...p, steps: [p.steps[0], p.steps[0]] }),
    (p: ReturnType<typeof params>) => ({
      ...p,
      steps: Array.from({ length: 33 }, (_, i) => ({ ...p.steps[0], id: "step" + i })),
    }),
    (p: ReturnType<typeof params>) => ({ ...p, maxAffectedRows: 0 }),
    (p: ReturnType<typeof params>) => ({
      ...p,
      steps: [{ ...p.steps[0], sql: "é".repeat(600000) }],
    }),
    (p: ReturnType<typeof params>) => ({
      ...p,
      steps: [
        {
          ...p.steps[0],
          params: { n: { kind: "value", scalar: { type: "integer", value: 9007199254740993 } } },
        },
      ],
    }),
  ])("rejects invalid envelope %#", (change) => {
    expect(sqlOperationExecuteParamsSchema.safeParse(change(params())).success).toBe(false);
  });
  it("documents all new methods in the OpenAPI command union", () => {
    const { spec } = buildSwaggerSpec();
    const text = JSON.stringify(spec);
    for (const method of ["sql.operation.execute", "sql.operation.get", "sql.operation.cancel"])
      expect(text).toContain(method);
    expect(text).toContain("SqlOperationStatus");
  });

  it("supports date-only scalars and zero-row preconditions", () => {
    const p = params();
    const check = {
      id: "check",
      effect: "select",
      sql: "SELECT id FROM synthetic WHERE id=:id",
      params: {},
      outputs: {},
      expectedRows: { min: 0, max: 0 },
    };
    expect(
      sqlOperationExecuteParamsSchema.safeParse({ ...p, steps: [check, ...p.steps] }).success,
    ).toBe(true);
  });
});
