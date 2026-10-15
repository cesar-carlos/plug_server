import { z } from "zod";
import {
  sqlOperationExecuteParamsSchema,
  sqlOperationReferenceParamsSchema,
} from "../../../shared/validators/sql_operation";

const commands = [
  ["RpcSqlOperationExecuteCommand", "sql.operation.execute", "SqlOperationExecuteParams"],
  ["RpcSqlOperationGetCommand", "sql.operation.get", "SqlOperationReferenceParams"],
  ["RpcSqlOperationCancelCommand", "sql.operation.cancel", "SqlOperationReferenceParams"],
] as const;

/** Derived from the same transport validators; refinements still run on every request. */
export const sqlOperationBridgeSchemas = {
  SqlOperationExecuteParams: z.toJSONSchema(sqlOperationExecuteParamsSchema, {
    target: "openapi-3.0",
  }),
  SqlOperationReferenceParams: z.toJSONSchema(sqlOperationReferenceParamsSchema, {
    target: "openapi-3.0",
  }),
  ...Object.fromEntries(
    commands.map(([name, method, params]) => [
      name,
      {
        type: "object",
        required: ["method", "params"],
        additionalProperties: true,
        properties: {
          jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
          method: { type: "string", enum: [method] },
          id: { oneOf: [{ type: "string", minLength: 1 }, { type: "number" }] },
          params: { $ref: "#/components/schemas/" + params },
          api_version: { type: "string", minLength: 1 },
          meta: { $ref: "#/components/schemas/RpcMeta" },
        },
      },
    ]),
  ),
  SqlOperationStatus: {
    type: "object",
    additionalProperties: false,
    required: [
      "operationId",
      "fingerprint",
      "executionId",
      "state",
      "directlyAffectedRows",
      "updatedAt",
    ],
    properties: {
      operationId: { type: "string", format: "uuid" },
      fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
      executionId: { type: "string" },
      state: {
        type: "string",
        enum: [
          "executando",
          "cancelamento_solicitado",
          "concluida",
          "rollback_confirmado",
          "resultado_desconhecido",
          "cancelada",
        ],
      },
      failureCode: {
        type: "string",
        enum: [
          "SOURCE_IDENTITY_MISMATCH",
          "SOURCE_STRUCTURE_MISMATCH",
          "SQL_OPERATION_CONDITION_FAILED",
          "SQL_OPERATION_ROW_LIMIT",
          "SQL_OPERATION_ROW_COUNT_UNKNOWN",
          "SQL_OPERATION_OUTPUT_INVALID",
          "SQL_OPERATION_AUTHORIZATION_CHANGED",
          "SQL_OPERATION_AUTHORIZATION_DENIED",
          "SQL_OPERATION_CANCELLED",
          "SQL_OPERATION_NATIVE_FAILED",
          "SQL_OPERATION_TIMEOUT",
          "SQL_OPERATION_INTERRUPTED",
          "SQL_OPERATION_FAILED",
        ],
        description:
          "Durable safe failure category, not a commit or rollback proof. Absent on older terminal records.",
      },
      directlyAffectedRows: { type: "integer", minimum: 0, nullable: true },
      updatedAt: { type: "string", format: "date-time" },
      completedAt: { type: "string", format: "date-time", nullable: true },
    },
    allOf: [
      {
        oneOf: [
          { not: { required: ["failureCode"] } },
          {
            required: ["failureCode"],
            properties: {
              state: { enum: ["cancelada", "rollback_confirmado", "resultado_desconhecido"] },
            },
          },
        ],
      },
    ],
    description:
      "Journal metadata; cancellation acceptance is not rollback. Unknown outcomes must never be retried automatically. Requires sqlOperations capability version 1 on the agent.",
  },
};
