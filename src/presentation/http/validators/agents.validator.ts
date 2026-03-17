import { z } from "zod";

import { nonEmptyStringSchema } from "../../../shared/validators/schemas";

const jsonRpcIdSchema = z.union([z.string().min(1), z.number().finite()]);

const tokenCarrierSchema = z
  .object({
    client_token: nonEmptyStringSchema.optional(),
    clientToken: nonEmptyStringSchema.optional(),
    auth: nonEmptyStringSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasToken =
      value.client_token !== undefined || value.clientToken !== undefined || value.auth !== undefined;

    if (!hasToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["client_token"],
        message: "Provide one of `client_token`, `clientToken` or `auth`",
      });
    }
  });

const sqlExecuteParamsSchema = z
  .object({
    sql: nonEmptyStringSchema,
    params: z.record(z.string(), z.unknown()).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .merge(tokenCarrierSchema)
  .passthrough();

const sqlExecuteBatchParamsSchema = z
  .object({
    commands: z
      .array(
        z
          .object({
            sql: nonEmptyStringSchema,
            params: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .min(1, { message: "At least one SQL command is required" })
      .max(32, { message: "Batch cannot exceed 32 commands" }),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .merge(tokenCarrierSchema)
  .passthrough();

const sqlCancelParamsSchema = z
  .object({
    execution_id: nonEmptyStringSchema.optional(),
    request_id: nonEmptyStringSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasExecutionId = value.execution_id !== undefined;
    const hasRequestId = value.request_id !== undefined;

    if (!hasExecutionId && !hasRequestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_id"],
        message: "Provide at least one of `execution_id` or `request_id`",
      });
    }
  })
  .passthrough();

const sqlExecuteCommandSchema = z
  .object({
    jsonrpc: z.literal("2.0").default("2.0"),
    method: z.literal("sql.execute"),
    id: jsonRpcIdSchema.optional(),
    params: sqlExecuteParamsSchema,
  })
  .passthrough();

const sqlExecuteBatchCommandSchema = z
  .object({
    jsonrpc: z.literal("2.0").default("2.0"),
    method: z.literal("sql.executeBatch"),
    id: jsonRpcIdSchema.optional(),
    params: sqlExecuteBatchParamsSchema,
  })
  .passthrough();

const sqlCancelCommandSchema = z
  .object({
    jsonrpc: z.literal("2.0").default("2.0"),
    method: z.literal("sql.cancel"),
    id: jsonRpcIdSchema.optional(),
    params: sqlCancelParamsSchema,
  })
  .passthrough();

const rpcDiscoverCommandSchema = z
  .object({
    jsonrpc: z.literal("2.0").default("2.0"),
    method: z.literal("rpc.discover"),
    id: jsonRpcIdSchema.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const bridgeCommandSchema = z.discriminatedUnion("method", [
  sqlExecuteCommandSchema,
  sqlExecuteBatchCommandSchema,
  sqlCancelCommandSchema,
  rpcDiscoverCommandSchema,
]);

const paginationSchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(50_000).optional(),
    cursor: nonEmptyStringSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasPage = value.page !== undefined || value.pageSize !== undefined;
    const hasBothPageAndSize = value.page !== undefined && value.pageSize !== undefined;
    const hasCursor = value.cursor !== undefined;

    if (hasPage && !hasBothPageAndSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["page"],
        message: "`page` and `pageSize` must be sent together",
      });
    }

    if (hasCursor && hasPage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cursor"],
        message: "`cursor` cannot be combined with `page`/`pageSize`",
      });
    }

    if (!hasCursor && !hasPage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["page"],
        message: "Provide either `cursor` or (`page` and `pageSize`)",
      });
    }
  });

export const agentCommandBodySchema = z.object({
  agentId: nonEmptyStringSchema,
  command: bridgeCommandSchema,
  timeoutMs: z.coerce.number().int().positive().max(60_000).optional(),
  pagination: paginationSchema.optional(),
});

export type AgentCommandBody = z.infer<typeof agentCommandBodySchema>;
