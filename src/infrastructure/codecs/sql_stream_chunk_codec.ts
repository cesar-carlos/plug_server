import { inspectSqlStreamChunk, readSqlChunkRows } from "./sql_stream_chunk_inspection";

export interface NormalizedSqlChunk {
  readonly payload: Record<string, unknown>;
  readonly originalSizeBytes: number;
}

/** Checks the expanded JSON budget before allocating any row objects. */
export const normalizeColumnarSqlChunk = (
  chunk: Record<string, unknown>,
  limits: { readonly maxRows: number; readonly maxBytes: number },
  admit?: (rowCount: number, expandedBytes: number) => boolean,
): NormalizedSqlChunk | null | undefined => {
  if (chunk.columnar === undefined) return null;
  const inspected = inspectSqlStreamChunk(chunk);
  if (!inspected.ok) throw new Error(inspected.message);
  const { columnar: _columnar, ...payload } = chunk;
  let size = Buffer.byteLength(JSON.stringify(payload));
  if (inspected.columns !== undefined) {
    if (inspected.rowCount > limits.maxRows)
      throw new Error("rpc:chunk exceeds negotiated row limit");
    const columns = inspected.columns;
    const keySizes = columns.map((column) => Buffer.byteLength(JSON.stringify(column.name)) + 1);
    size += Math.max(0, inspected.rowCount - 1);
    for (let row = 0; row < inspected.rowCount; row++) {
      size += 2 + Math.max(0, columns.length - 1);
      for (const [index, column] of columns.entries()) {
        size += keySizes[index]! + Buffer.byteLength(JSON.stringify(column.values[row]));
      }
      if (size > limits.maxBytes)
        throw new Error("Normalized rpc:chunk exceeds payload byte limit");
    }
  }
  if (size > limits.maxBytes) throw new Error("Normalized rpc:chunk exceeds payload byte limit");
  if (admit !== undefined && !admit(inspected.rowCount, size)) return undefined;
  if (inspected.columns !== undefined) payload.rows = readSqlChunkRows(chunk);
  return { payload, originalSizeBytes: size };
};
