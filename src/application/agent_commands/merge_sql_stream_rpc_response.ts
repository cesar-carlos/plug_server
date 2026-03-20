/**
 * Merges plug_agente streaming payloads (initial `rpc:response` + `rpc:chunk` rows + `rpc:complete`)
 * into a single JSON-RPC response for HTTP clients.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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

  const rows: unknown[] = [];
  const initialRows = result.rows;
  if (Array.isArray(initialRows)) {
    rows.push(...initialRows);
  }

  for (const chunk of chunks) {
    const chunkRows = chunk.rows;
    if (Array.isArray(chunkRows)) {
      rows.push(...chunkRows);
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
