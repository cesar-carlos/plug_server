import { expect, it } from "vitest";
import {
  assertSqlOperationTransport,
  requiresLiveSqlCapability,
} from "../../../../src/application/agent_commands/sql_operation_transport_guard";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";
import { sourceDiscoveryResultSchema } from "../../../../src/shared/validators/source_discovery";
const raw = {
  method: "sql.describeSource",
  id: "request",
  params: { contractVersion: 1, database: "fixture", client_token: "technical" },
};
it("discovery requires live version 1 independently of SQL operation opt-in", () => {
  const command = bridgeSingleCommandSchema.parse(raw);
  expect(requiresLiveSqlCapability(command)).toBe(true);
  for (const value of [undefined, null, false, true, 2, "1"])
    expect(() =>
      assertSqlOperationTransport(command, { extensions: { sourceDiscovery: value } }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
  expect(() =>
    assertSqlOperationTransport(command, { extensions: { sourceDiscovery: 1 } }),
  ).not.toThrow();
});
it("discovery contracts exclude caller SQL, connection strings and incomplete identities", () => {
  for (const additional of [
    { sql: "SELECT secret" },
    { connectionString: "DSN=other" },
    { database: "fixture;SERVER=other" },
  ])
    expect(
      bridgeSingleCommandSchema.safeParse({ ...raw, params: { ...raw.params, ...additional } })
        .success,
    ).toBe(false);
  const proof = {
    contractVersion: 1,
    database: "fixture",
    dialect: "postgres",
    identityHash: "a".repeat(64),
    identityKind: "native",
    engineVersion: "fixture",
    verifiedAt: "2026-10-11T00:00:00Z",
  };
  expect(sourceDiscoveryResultSchema.safeParse(proof).success).toBe(true);
  expect(
    sourceDiscoveryResultSchema.safeParse({
      ...proof,
      dialect: "sybase",
      identityKind: "provisioned",
    }).success,
  ).toBe(true);
  expect(
    sourceDiscoveryResultSchema.safeParse({ ...proof, identityKind: "invented" }).success,
  ).toBe(false);
  expect(sourceDiscoveryResultSchema.safeParse({ ...proof, identityHash: "fixture" }).success).toBe(
    false,
  );
});

it("should reject firebird on expectedSource and sql.describeSource results", () => {
  const proof = {
    contractVersion: 1,
    database: "fixture",
    dialect: "firebird",
    identityHash: "a".repeat(64),
    identityKind: "native",
    engineVersion: "fixture",
    verifiedAt: "2026-10-11T00:00:00Z",
  };
  expect(sourceDiscoveryResultSchema.safeParse(proof).success).toBe(false);
  expect(
    bridgeSingleCommandSchema.safeParse({
      method: "sql.execute",
      id: "read",
      params: {
        sql: "SELECT id FROM fixture",
        database: "fixture",
        client_token: "technical",
        expectedSource: { version: 1, dialect: "firebird", identityHash: "a".repeat(64) },
      },
    }).success,
  ).toBe(false);
});

it("verified SELECT preserves expected native identity and requires live capability in mixed batches", () => {
  const expectedSource = { version: 1, dialect: "postgres", identityHash: "a".repeat(64) };
  const command = bridgeSingleCommandSchema.parse({
    method: "sql.execute",
    id: "read",
    params: {
      sql: "SELECT id FROM fixture",
      database: "fixture",
      client_token: "technical",
      expectedSource,
    },
  });
  expect(command.params).toMatchObject({ expectedSource });
  expect(requiresLiveSqlCapability(command)).toBe(true);
  for (const sourceIdentity of [undefined, null, false, true, 2, "1"])
    expect(() => assertSqlOperationTransport(command, { extensions: { sourceIdentity } })).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  expect(() =>
    assertSqlOperationTransport(command, { extensions: { sourceIdentity: 1 } }),
  ).not.toThrow();
  expect(() =>
    assertSqlOperationTransport([command, bridgeSingleCommandSchema.parse(raw)], {
      extensions: { sourceDiscovery: 1 },
    }),
  ).toThrow();
  expect(
    bridgeSingleCommandSchema.safeParse({
      method: "sql.execute",
      params: {
        sql: "SELECT id FROM fixture",
        expectedSource: { ...expectedSource, identityHash: "fixture" },
      },
    }).success,
  ).toBe(false);
});
