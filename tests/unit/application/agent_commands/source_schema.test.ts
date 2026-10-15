import { expect, it } from "vitest";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";
import {
  assertSqlOperationTransport,
  requiresLiveSqlCapability,
} from "../../../../src/application/agent_commands/sql_operation_transport_guard";
const expectedSource = { version: 1, dialect: "postgres", identityHash: "a".repeat(64) };
const resource = { schema: "public", name: "fixture", type: "table" };
it("schema inspection requires exact negotiated schema and identity capabilities and excludes caller SQL", () => {
  const raw = {
    method: "sql.describeSchema",
    id: "metadata",
    params: {
      contractVersion: 1,
      database: "fixture",
      client_token: "fixture-technical",
      expectedSource,
      resources: [resource],
    },
  };
  const command = bridgeSingleCommandSchema.parse(raw);
  expect(requiresLiveSqlCapability(command)).toBe(true);
  for (const extensions of [
    { sourceSchema: 1 },
    { sourceIdentity: 1 },
    { sourceSchema: true, sourceIdentity: 1 },
    { sourceSchema: 2, sourceIdentity: 1 },
  ])
    expect(() => assertSqlOperationTransport(command, { extensions })).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  expect(() =>
    assertSqlOperationTransport(command, { extensions: { sourceSchema: 1, sourceIdentity: 1 } }),
  ).not.toThrow();
  expect(
    bridgeSingleCommandSchema.safeParse({ ...raw, params: { ...raw.params, sql: "SELECT hidden" } })
      .success,
  ).toBe(false);
});
it("verified SELECT preserves structural expectations without enabling legacy fallback", () => {
  const raw = {
    method: "sql.execute",
    id: "query",
    params: {
      sql: "SELECT id FROM public.fixture WHERE id=:id",
      database: "fixture",
      client_token: "fixture-technical",
      expectedSource,
      expectedStructure: {
        version: 1,
        resources: [
          {
            resource,
            columns: [{ name: "id", nativeType: "int4", nullable: false, size: 10, scale: 0 }],
          },
        ],
      },
    },
  };
  const command = bridgeSingleCommandSchema.parse(raw);
  expect(command.params).toHaveProperty("expectedStructure", raw.params.expectedStructure);
  expect(() => assertSqlOperationTransport(command, { extensions: { sourceIdentity: 1 } })).toThrow(
    expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
  );
  expect(() =>
    assertSqlOperationTransport(command, { extensions: { sourceIdentity: 1, sourceSchema: 1 } }),
  ).not.toThrow();
  expect(
    bridgeSingleCommandSchema.safeParse({
      ...raw,
      params: { ...raw.params, expectedSource: undefined },
    }).success,
  ).toBe(false);
});

it("constraint expectation refuses old agents even when columns are supported", () => {
  const command = bridgeSingleCommandSchema.parse({
    method: "sql.execute",
    id: "guard",
    params: {
      sql: "SELECT id FROM public.fixture",
      database: "fixture",
      client_token: "fixture-technical",
      expectedSource,
      expectedStructure: {
        version: 1,
        resources: [
          {
            resource,
            columns: [{ name: "id", nativeType: "int4", nullable: false, size: 10, scale: 0 }],
            constraints: {
              primaryKeys: [{ name: "pk", columns: ["id"], status: "enabled" }],
              uniqueKeys: [],
              foreignKeys: [],
            },
          },
        ],
      },
    },
  });
  expect(() =>
    assertSqlOperationTransport(command, { extensions: { sourceIdentity: 1, sourceSchema: 1 } }),
  ).toThrow(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
  expect(() =>
    assertSqlOperationTransport(command, {
      extensions: { sourceIdentity: 1, sourceSchema: 1, sourceConstraints: 1 },
    }),
  ).not.toThrow();
});
