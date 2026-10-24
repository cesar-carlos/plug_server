import {
  inspectSqlStreamChunk,
  expandInspectedSqlChunkRows,
  type ValidSqlChunkInspection,
} from "./sql_stream_chunk_inspection";

export interface NormalizedSqlChunk {
  readonly payload: Record<string, unknown>;
  readonly originalSizeBytes: number;
}

/** Lone surrogates and JSON escapes do not match a raw UTF-8 length. */
const jsonStringBytes = (value: string): number => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x22 || code === 0x5c || code === 0x2028 || code === 0x2029) {
      return Buffer.byteLength(JSON.stringify(value));
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return Buffer.byteLength(JSON.stringify(value));
    }
    if (code >= 0xdc00 && code <= 0xdfff) return Buffer.byteLength(JSON.stringify(value));
  }
  return Buffer.byteLength(value) + 2;
};

/** Exact JSON lengths for decoded primitives; strings/objects retain JSON escaping. */
const jsonValueBytes = (value: unknown): number => {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "string") return jsonStringBytes(value);
  return Buffer.byteLength(JSON.stringify(value));
};

/** Checks the expanded JSON budget before allocating any row objects. */
export const normalizeColumnarSqlChunk = (
  chunk: Record<string, unknown>,
  limits: { readonly maxRows: number; readonly maxBytes: number },
  admit?: (rowCount: number, expandedBytes: number) => boolean,
  inspection?: ValidSqlChunkInspection,
): NormalizedSqlChunk | null | undefined => {
  if (chunk.columnar === undefined) return null;
  const inspected = inspection ?? inspectSqlStreamChunk(chunk);
  if (!inspected.ok) throw new Error(inspected.message);
  const { columnar: _columnar, ...payload } = chunk;
  let size = Buffer.byteLength(JSON.stringify(payload));
  if (inspected.columns !== undefined) {
    if (inspected.rowCount > limits.maxRows)
      throw new Error("rpc:chunk exceeds negotiated row limit");
    const columns = inspected.columns;
    const rowOverhead = columns.reduce(
      (bytes, column) => bytes + Buffer.byteLength(JSON.stringify(column.name)) + 1,
      2 + Math.max(0, columns.length - 1),
    );
    size += Math.max(0, inspected.rowCount - 1);
    for (let row = 0; row < inspected.rowCount; row++) {
      size += rowOverhead;
      for (const column of columns) {
        size += jsonValueBytes(column.values[row]);
      }
      if (size > limits.maxBytes)
        throw new Error("Normalized rpc:chunk exceeds payload byte limit");
    }
  }
  if (size > limits.maxBytes) throw new Error("Normalized rpc:chunk exceeds payload byte limit");
  if (admit !== undefined && !admit(inspected.rowCount, size)) return undefined;
  if (inspected.columns !== undefined) payload.rows = expandInspectedSqlChunkRows(inspected);
  return { payload, originalSizeBytes: size };
};
