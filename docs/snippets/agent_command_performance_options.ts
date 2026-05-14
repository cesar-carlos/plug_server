type SqlExecutePerformanceInput = {
  readonly sql: string;
  readonly estimatedRows?: number;
  readonly estimatedPayloadBytes?: number;
  readonly reportLike?: boolean;
  readonly clientToken?: string;
};

type SqlExecuteBatchPerformanceInput = {
  readonly commands: readonly { sql: string; params?: Record<string, unknown> }[];
  readonly readOnly?: boolean;
  readonly poolSize?: number;
  readonly clientToken?: string;
};

const LARGE_RESULT_ROWS = 10_000;
const LARGE_RESULT_BYTES = 5 * 1024 * 1024;

export const buildSqlExecuteCommand = (input: SqlExecutePerformanceInput) => {
  const preferStreaming =
    input.reportLike === true ||
    (input.estimatedRows ?? 0) >= LARGE_RESULT_ROWS ||
    (input.estimatedPayloadBytes ?? 0) >= LARGE_RESULT_BYTES;

  return {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    api_version: "2.10",
    method: "sql.execute",
    params: {
      sql: input.sql,
      ...(input.clientToken ? { client_token: input.clientToken } : {}),
      options: {
        ...(preferStreaming ? { prefer_db_streaming: true } : {}),
      },
    },
  };
};

export const buildReadOnlyBatchCommand = (input: SqlExecuteBatchPerformanceInput) => {
  const maxParallel = input.readOnly === true ? Math.min(Math.max(input.poolSize ?? 2, 1), 8) : 1;

  return {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    api_version: "2.10",
    method: "sql.executeBatch",
    params: {
      commands: input.commands,
      ...(input.clientToken ? { client_token: input.clientToken } : {}),
      options: {
        max_parallel_read_only_batch_items: maxParallel,
      },
    },
  };
};
