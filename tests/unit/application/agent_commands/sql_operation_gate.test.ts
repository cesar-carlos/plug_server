import { expect, it } from "vitest";
import { assertSqlOperationTransport } from "../../../../src/application/agent_commands/sql_operation_transport_guard";
import {
  SQL_OPERATION_TRANSPORT,
  negotiateSqlOperations,
} from "../../../../src/shared/constants/sql_operation_transport";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";

it.each(["sql.operation.execute", "sql.operation.get", "sql.operation.cancel"])(
  "negotiates %s fail-closed for old or incompatible agents",
  async (method) => {
    const reference = {
      contractVersion: 1,
      operationId: "11111111-1111-4111-8111-111111111111",
      fingerprint: "a".repeat(64),
      sourcePhysicalId: "b".repeat(64),
      database: "fixture",
    };
    const params =
      method === "sql.operation.execute"
        ? {
            ...reference,
            timeoutMs: 1000,
            maxAffectedRows: 1,
            steps: [
              {
                id: "write",
                effect: "update",
                sql: "UPDATE fixture SET value=:value WHERE id=:id",
                params: {},
                outputs: {},
                affectedRows: { min: 1, max: 1 },
              },
            ],
          }
        : reference;
    const command = bridgeSingleCommandSchema.parse({ method, id: "request", params });
    for (const input of [command, [command]]) {
      for (const raw of [
        undefined,
        null,
        true,
        {},
        { ...SQL_OPERATION_TRANSPORT, enabled: false },
        { ...SQL_OPERATION_TRANSPORT, version: 2 },
        { ...SQL_OPERATION_TRANSPORT, durableJournal: false },
        { ...SQL_OPERATION_TRANSPORT, automaticReplay: true },
        { ...SQL_OPERATION_TRANSPORT, maxSteps: 0 },
        { ...SQL_OPERATION_TRANSPORT, maxSteps: 1.5 },
      ]) {
        expect(() =>
          assertSqlOperationTransport(input, { extensions: { sqlOperations: raw } }),
        ).toThrow(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE", statusCode: 409 }));
      }
      expect(() =>
        assertSqlOperationTransport(input, {
          extensions: { sqlOperations: SQL_OPERATION_TRANSPORT },
        }),
      ).not.toThrow();
    }
  },
);

it("requires the exact structural-operation capability on every batch item", () => {
  const command = bridgeSingleCommandSchema.parse({
    method: "sql.operation.execute",
    id: "structure",
    params: {
      contractVersion: 1,
      operationId: "11111111-1111-4111-8111-111111111111",
      fingerprint: "a".repeat(64),
      sourcePhysicalId: "b".repeat(64),
      database: "fixture",
      timeoutMs: 1000,
      maxAffectedRows: 1,
      expectedSource: { version: 1, dialect: "postgres", identityHash: "a".repeat(64) },
      expectedStructure: {
        version: 1,
        resources: [
          {
            resource: { schema: "public", name: "fixture", type: "table" },
            columns: [{ name: "id", nativeType: "int4", nullable: false, size: 32, scale: 0 }],
            constraints: { primaryKeys: [], uniqueKeys: [], foreignKeys: [] },
          },
        ],
      },
      steps: [
        {
          id: "write",
          effect: "update",
          sql: "UPDATE fixture SET value=:value WHERE id=:id",
          params: {},
          outputs: {},
          affectedRows: { min: 1, max: 1 },
        },
      ],
    },
  });
  const extensions = {
    sourceIdentity: 1,
    sourceSchema: 1,
    sourceConstraints: 1,
    sqlOperations: SQL_OPERATION_TRANSPORT,
  };
  for (const input of [command, [command]]) {
    expect(() => assertSqlOperationTransport(input, { extensions })).not.toThrow();
    for (const version of [undefined, 0, 2, true])
      expect(() =>
        assertSqlOperationTransport(input, {
          extensions: {
            ...extensions,
            sqlOperations: { ...SQL_OPERATION_TRANSPORT, structureGuard: version },
          },
        }),
      ).toThrow();
    for (const capability of ["sourceIdentity", "sourceSchema", "sourceConstraints"])
      expect(() =>
        assertSqlOperationTransport(input, {
          extensions: { ...extensions, [capability]: undefined },
        }),
      ).toThrow();
  }
});
it("reduces negotiated ceilings and refuses exceeding plans without rewriting them", () => {
  expect(
    negotiateSqlOperations({ ...SQL_OPERATION_TRANSPORT, maxSteps: 100, timeoutMs: 500 }),
  ).toEqual({ maxSteps: 32, maxAffectedRows: 100000, timeoutMs: 500, structureGuard: 1 });
});
