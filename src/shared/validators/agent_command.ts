/**
 * Transport-agnostic schemas for agent RPC commands.
 * Used by HTTP validators and Socket consumer handlers.
 */

import { z } from "zod";

import { nonEmptyStringSchema } from "./schemas";

const jsonRpcIdSchema = z.union([z.string().min(1), z.number().finite(), z.null()]);
const rpcTimestampSchema = z.string().datetime({ offset: true });
const rpcMetaSchema = z
  .object({
    trace_id: nonEmptyStringSchema.optional(),
    traceparent: nonEmptyStringSchema.optional(),
    tracestate: nonEmptyStringSchema.optional(),
    request_id: nonEmptyStringSchema.optional(),
    agent_id: nonEmptyStringSchema.optional(),
    timestamp: rpcTimestampSchema.optional(),
  })
  .passthrough();
const rpcEnvelopeExtensionsSchema = z.object({
  api_version: nonEmptyStringSchema.optional(),
  meta: rpcMetaSchema.optional(),
});

const tokenCarrierSchema = z
  .object({
    client_token: nonEmptyStringSchema.optional(),
    clientToken: nonEmptyStringSchema.optional(),
    auth: nonEmptyStringSchema.optional(),
  });

const sqlExecuteOptionsSchema = z
  .object({
    timeout_ms: z.number().int().positive().optional(),
    max_rows: z.number().int().positive().optional(),
    page: z.number().int().positive().optional(),
    page_size: z.number().int().positive().optional(),
    cursor: nonEmptyStringSchema.optional(),
    multi_result: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPage = value.page !== undefined || value.page_size !== undefined;
    const hasPageAndSize = value.page !== undefined && value.page_size !== undefined;
    const hasCursor = value.cursor !== undefined;
    if (hasPage && !hasPageAndSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["page"],
        message: "`page` and `page_size` must be sent together",
      });
    }

    if (hasCursor && hasPage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cursor"],
        message: "`cursor` cannot be combined with `page`/`page_size`",
      });
    }

    if (value.multi_result === true && (hasPage || hasCursor)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["multi_result"],
        message: "`multi_result` cannot be combined with pagination",
      });
    }
  });

const sqlExecuteParamsSchema = z
  .object({
    sql: nonEmptyStringSchema,
    params: z.record(z.string(), z.unknown()).optional(),
    options: sqlExecuteOptionsSchema.optional(),
    idempotency_key: nonEmptyStringSchema.optional(),
    database: nonEmptyStringSchema.optional(),
  })
  .merge(tokenCarrierSchema)
  .superRefine((value, ctx) => {
    if (value.options?.multi_result === true && value.params !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", "multi_result"],
        message: "`multi_result` cannot be combined with named `params`",
      });
    }
  })
  .strict();

const sqlExecuteBatchCommandItemSchema = z
  .object({
    sql: nonEmptyStringSchema,
    params: z.record(z.string(), z.unknown()).optional(),
    execution_order: z.number().int().min(0).optional(),
  })
  .strict();

const sqlExecuteBatchOptionsSchema = z
  .object({
    timeout_ms: z.number().int().positive().optional(),
    max_rows: z.number().int().positive().optional(),
    transaction: z.boolean().optional(),
  })
  .strict();

const sqlExecuteBatchParamsSchema = z
  .object({
    commands: z.array(sqlExecuteBatchCommandItemSchema).min(1).max(32),
    options: sqlExecuteBatchOptionsSchema.optional(),
    idempotency_key: nonEmptyStringSchema.optional(),
    database: nonEmptyStringSchema.optional(),
  })
  .merge(tokenCarrierSchema)
  .strict();

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
  .strict();

const sqlExecuteCommandSchema = z
  .object({
    jsonrpc: z.literal("2.0").default("2.0"),
    method: z.literal("sql.execute"),
    id: jsonRpcIdSchema.optional(),
    params: sqlExecuteParamsSchema,
  })
  .merge(rpcEnvelopeExtensionsSchema)
  .passthrough();

const sqlExecuteBatchCommandSchema = z
  .object({
    jsonrpc: z.literal("2.0").default("2.0"),
    method: z.literal("sql.executeBatch"),
    id: jsonRpcIdSchema.optional(),
    params: sqlExecuteBatchParamsSchema,
  })
  .merge(rpcEnvelopeExtensionsSchema)
  .passthrough();

const sqlCancelCommandSchema = z
  .object({
    jsonrpc: z.literal("2.0").default("2.0"),
    method: z.literal("sql.cancel"),
    id: jsonRpcIdSchema.optional(),
    params: sqlCancelParamsSchema,
  })
  .merge(rpcEnvelopeExtensionsSchema)
  .passthrough();

const rpcDiscoverCommandSchema = z
  .object({
    jsonrpc: z.literal("2.0").default("2.0"),
    method: z.literal("rpc.discover"),
    id: jsonRpcIdSchema.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .merge(rpcEnvelopeExtensionsSchema)
  .passthrough();

export const supportedAgentRpcMethods = [
  "sql.execute",
  "sql.executeBatch",
  "sql.cancel",
  "rpc.discover",
] as const;

export const bridgeSingleCommandSchema = z.discriminatedUnion("method", [
  sqlExecuteCommandSchema,
  sqlExecuteBatchCommandSchema,
  sqlCancelCommandSchema,
  rpcDiscoverCommandSchema,
]);

const bridgeBatchCommandSchema = z
  .array(bridgeSingleCommandSchema)
  .min(1, { message: "Batch must include at least one command" })
  .max(32, { message: "Batch cannot exceed 32 commands" })
  .superRefine((items, ctx) => {
    const seenIds = new Set<string>();
    items.forEach((item, index) => {
      const id = item.id;
      if (id === undefined || id === null) {
        return;
      }

      const normalizedId = String(id);
      if (seenIds.has(normalizedId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: "Batch ids must be unique",
        });
        return;
      }

      seenIds.add(normalizedId);
    });
  });

export const bridgeCommandSchema = z.union([bridgeSingleCommandSchema, bridgeBatchCommandSchema]);

export type BridgeSingleCommand = z.infer<typeof bridgeSingleCommandSchema>;
export type BridgeBatchCommand = z.infer<typeof bridgeBatchCommandSchema>;
export type BridgeCommand = z.infer<typeof bridgeCommandSchema>;

export const agentCommandPaginationSchema = z
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

    if (!hasCursor && !hasBothPageAndSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["page"],
        message: "Provide either `cursor` or (`page` and `pageSize`)",
      });
    }
  });

export type AgentCommandPagination = z.infer<typeof agentCommandPaginationSchema>;

export const agentCommandBodySchema = z.object({
  agentId: nonEmptyStringSchema,
  command: bridgeCommandSchema,
  timeoutMs: z.coerce.number().int().positive().max(60_000).optional(),
  pagination: agentCommandPaginationSchema.optional(),
})
  .superRefine((value, ctx) => {
    if (!value.pagination) {
      return;
    }

    if (Array.isArray(value.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pagination"],
        message: "`pagination` is supported only for single `sql.execute` commands",
      });
      return;
    }

    if (value.command.method !== "sql.execute") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pagination"],
        message: "`pagination` is supported only for `sql.execute`",
      });
      return;
    }

    if (value.command.params.options?.multi_result === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pagination"],
        message: "`pagination` cannot be combined with `options.multi_result=true`",
      });
    }
  });

export type AgentCommandBody = z.infer<typeof agentCommandBodySchema>;
