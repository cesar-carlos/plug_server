/**
 * Merges plug_agente streaming payloads (initial `rpc:response` + `rpc:chunk` rows + `rpc:complete`)
 * into a single JSON-RPC response for HTTP clients.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Appends without `push(...source)` to avoid JS call-argument limits on very large chunks. */
const appendArrayElements = (target: unknown[], source: readonly unknown[]): void => {
  const len = source.length;
  for (let i = 0; i < len; i += 1) {
    target.push(source[i]);
  }
};

export const appendSqlStreamChunkRows = (
  target: unknown[],
  chunk: Record<string, unknown>,
): number => {
  const chunkRows = chunk.rows;
  if (!Array.isArray(chunkRows)) {
    return 0;
  }
  appendArrayElements(target, chunkRows);
  return chunkRows.length;
};

export const mergeSqlStreamRpcResponse = (
  initialRpc: unknown,
  chunks: readonly Record<string, unknown>[],
  complete: Record<string, unknown>,
): unknown => {
  const envelope = isRecord(initialRpc) ? initialRpc : null;
  if (!envelope) {
    return initialRpc;
  }

  const result = isRecord(envelope.result) ? envelope.result : null;
  if (!result) {
    return initialRpc;
  }

  const terminalStatus = complete.terminal_status;
  if (terminalStatus === "aborted" || terminalStatus === "error") {
    throw new Error(`Agent SQL stream ended with terminal_status=${terminalStatus}`);
  }

  const rows: unknown[] = [];
  const initialRows = result.rows;
  if (Array.isArray(initialRows)) {
    appendArrayElements(rows, initialRows);
  }

  for (const chunk of chunks) {
    const chunkRows = chunk.rows;
    if (Array.isArray(chunkRows)) {
      appendArrayElements(rows, chunkRows);
    }
  }

  const totalFromComplete =
    typeof complete.total_rows === "number" && Number.isFinite(complete.total_rows)
      ? complete.total_rows
      : rows.length;

  const mergedResult: Record<string, unknown> = {
    ...result,
    rows,
    total_rows: totalFromComplete,
  };
  delete mergedResult.stream_id;

  return {
    ...envelope,
    result: mergedResult,
  };
};

export const mergeSqlStreamRpcResponseWithAppendedRows = (
  initialRpc: unknown,
  appendedRows: readonly unknown[],
  complete: Record<string, unknown>,
): unknown => {
  const envelope = isRecord(initialRpc) ? initialRpc : null;
  if (!envelope) {
    return initialRpc;
  }

  const result = isRecord(envelope.result) ? envelope.result : null;
  if (!result) {
    return initialRpc;
  }

  const terminalStatus = complete.terminal_status;
  if (terminalStatus === "aborted" || terminalStatus === "error") {
    throw new Error(`Agent SQL stream ended with terminal_status=${terminalStatus}`);
  }

  const initialRows = Array.isArray(result.rows) ? result.rows : [];
  const rows =
    appendedRows.length === 0
      ? initialRows.slice()
      : (() => {
          const mergedRows = initialRows.slice();
          appendArrayElements(mergedRows, appendedRows);
          return mergedRows;
        })();

  const totalFromComplete =
    typeof complete.total_rows === "number" && Number.isFinite(complete.total_rows)
      ? complete.total_rows
      : rows.length;

  const mergedResult: Record<string, unknown> = {
    ...result,
    rows,
    total_rows: totalFromComplete,
  };
  delete mergedResult.stream_id;

  return {
    ...envelope,
    result: mergedResult,
  };
};

/** Row count from `result.rows` in the initial `rpc:response` envelope (REST materialization budgeting). */
export const countSqlExecuteResultRowsInEnvelope = (envelope: unknown): number => {
  const record = isRecord(envelope) ? envelope : null;
  if (!record) {
    return 0;
  }
  const result = isRecord(record.result) ? record.result : null;
  if (!result) {
    return 0;
  }
  const initialRows = result.rows;
  return Array.isArray(initialRows) ? initialRows.length : 0;
};

/** Row count from a single `rpc:chunk` payload's `rows` array. */
export const countSqlStreamChunkRows = (chunk: Record<string, unknown>): number => {
  const chunkRows = chunk.rows;
  return Array.isArray(chunkRows) ? chunkRows.length : 0;
};
