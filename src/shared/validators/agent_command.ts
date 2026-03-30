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
    /** plug_agente: influences agent→hub PayloadFrame compression for this call (and matching stream events). */
    outbound_compression: z.enum(["none", "gzip", "auto"]).optional(),
  })
  .passthrough();
const rpcEnvelopeExtensionsSchema = z.object({
  api_version: nonEmptyStringSchema.optional(),
  meta: rpcMetaSchema.optional(),
});

const tokenCarrierSchema = z.object({
  client_token: nonEmptyStringSchema.optional(),
  clientToken: nonEmptyStringSchema.optional(),
  auth: nonEmptyStringSchema.optional(),
});

/** Maximum allowed value for options.max_rows, aligned with plug_agente negotiated limits. */
export const AGENT_MAX_ROWS_LIMIT = 1_000_000;

/** Maximum allowed value for options.timeout_ms (5 minutes). */
export const AGENT_TIMEOUT_MS_LIMIT = 300_000;

/** Maximum allowed value for options.page_size and body.pagination.pageSize. */
export const AGENT_PAGE_SIZE_LIMIT = 50_000;

/** Max UTF-8 bytes for a single SQL string (logical JSON-RPC before PayloadFrame). */
export const AGENT_SQL_MAX_UTF8_BYTES = 1 * 1024 * 1024;

/** Max UTF-8 bytes for JSON-serialized named `params` on `sql.execute` / batch command items. */
export const AGENT_SQL_NAMED_PARAMS_JSON_MAX_BYTES = 2 * 1024 * 1024;

/** Max UTF-8 bytes for serialized `params` on `rpc.discover`. */
export const AGENT_RPC_DISCOVER_PARAMS_JSON_MAX_BYTES = 64 * 1024;

const utf8ByteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const refineSqlTextAndNamedParams = (
  sql: string,
  params: Record<string, unknown> | undefined,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[],
): void => {
  if (utf8ByteLength(sql) > AGENT_SQL_MAX_UTF8_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, "sql"],
      message: `SQL text exceeds max UTF-8 size (${AGENT_SQL_MAX_UTF8_BYTES} bytes)`,
    });
  }
  if (params === undefined) {
    return;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(params);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, "params"],
      message: "`params` must be JSON-serializable",
    });
    return;
  }
  if (utf8ByteLength(encoded) > AGENT_SQL_NAMED_PARAMS_JSON_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, "params"],
      message: `Named params JSON exceeds max UTF-8 size (${AGENT_SQL_NAMED_PARAMS_JSON_MAX_BYTES} bytes)`,
    });
  }
};

export const sqlExecuteOptionsSchema = z
  .object({
    timeout_ms: z.number().int().positive().max(AGENT_TIMEOUT_MS_LIMIT).optional(),
    max_rows: z.number().int().positive().max(AGENT_MAX_ROWS_LIMIT).optional(),
    page: z.number().int().positive().optional(),
    page_size: z.number().int().positive().max(AGENT_PAGE_SIZE_LIMIT).optional(),
    cursor: nonEmptyStringSchema.optional(),
    execution_mode: z.enum(["managed", "preserve"]).optional(),
    preserve_sql: z.boolean().optional(),
    multi_result: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPage = value.page !== undefined || value.page_size !== undefined;
    const hasPageAndSize = value.page !== undefined && value.page_size !== undefined;
    const hasCursor = value.cursor !== undefined;
    const hasPagination = hasPage || hasCursor;
    const isPreserve = value.execution_mode === "preserve" || value.preserve_sql === true;

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

    if (value.multi_result === true && hasPagination) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["multi_result"],
        message: "`multi_result` cannot be combined with pagination",
      });
    }

    if (isPreserve && hasPagination) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_mode"],
        message:
          "`execution_mode: preserve` and `preserve_sql` cannot be combined with `page`, `page_size` or `cursor`",
      });
    }

    if (value.execution_mode === "managed" && value.preserve_sql === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_mode"],
        message: "`execution_mode: managed` cannot be combined with `preserve_sql: true`",
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
    refineSqlTextAndNamedParams(value.sql, value.params, ctx, []);
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
  .strict()
  .superRefine((item, ctx) => {
    refineSqlTextAndNamedParams(item.sql, item.params, ctx, []);
  });

const sqlExecuteBatchOptionsSchema = z
  .object({
    timeout_ms: z.number().int().positive().max(AGENT_TIMEOUT_MS_LIMIT).optional(),
    max_rows: z.number().int().positive().max(AGENT_MAX_ROWS_LIMIT).optional(),
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
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.params === undefined) {
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(value.params);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params"],
        message: "`params` must be JSON-serializable",
      });
      return;
    }
    if (utf8ByteLength(encoded) > AGENT_RPC_DISCOVER_PARAMS_JSON_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params"],
        message: `rpc.discover params exceed max UTF-8 size (${AGENT_RPC_DISCOVER_PARAMS_JSON_MAX_BYTES} bytes)`,
      });
    }
  });

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
    pageSize: z.coerce.number().int().positive().max(AGENT_PAGE_SIZE_LIMIT).optional(),
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

/** Gzip policy for hub-originated PayloadFrames to the agent (REST, agents:command). */
export const payloadFrameCompressionSchema = z.enum(["default", "none", "always"]);
export type PayloadFrameCompression = z.infer<typeof payloadFrameCompressionSchema>;

export const agentCommandBodySchema = z
  .object({
    agentId: nonEmptyStringSchema,
    command: bridgeCommandSchema,
    /** Bridge wait (HTTP/Socket): aligned with `computeBridgeWaitTimeoutMs` ceiling (`AGENT_TIMEOUT_MS_LIMIT` + 60s headroom). */
    timeoutMs: z.coerce.number().int().positive().max(360_000).optional(),
    pagination: agentCommandPaginationSchema.optional(),
    /**
     * Optional gzip policy for `rpc:request` PayloadFrames emitted to the agent.
     * Omitted or `default`: threshold 1024, **auto** — gzip only if strictly smaller than raw JSON (plug_agente OutboundCompressionMode.auto).
     * `none`: never gzip. `always`: threshold 1, **always_gzip** — gzip even if larger (plug_agente “sempre GZIP”).
     */
    payloadFrameCompression: payloadFrameCompressionSchema.optional(),
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

    const isPreserve =
      value.command.params.options?.execution_mode === "preserve" ||
      value.command.params.options?.preserve_sql === true;
    if (isPreserve) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pagination"],
        message:
          "`pagination` cannot be combined with `options.execution_mode=preserve` or `options.preserve_sql=true`",
      });
    }
  });

export type AgentCommandBody = z.infer<typeof agentCommandBodySchema>;
