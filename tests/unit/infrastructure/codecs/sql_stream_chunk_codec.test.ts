import { describe, expect, it } from "vitest";
import { normalizeColumnarSqlChunk } from "../../../../src/infrastructure/codecs/sql_stream_chunk_codec";
import { countSqlChunkRows } from "../../../../src/infrastructure/codecs/sql_stream_chunk_inspection";

const chunk = {
  stream_id: "s",
  request_id: "r",
  chunk_index: 0,
  rows: [],
  columnar: {
    row_count: 2,
    columns: [
      { name: "id", type: "int32", values: [1, 2] },
      { name: "name", type: "object", values: ["ação 🎉", null] },
      { name: "amount", type: "float64", values: [1.25, 2.5] },
      { name: "large", type: "int64", values: [1234567890123, 1234567890124] },
    ],
  },
};
const limits = { maxRows: 50000, maxBytes: 10 * 1024 * 1024 };

describe("columnar SQL chunk normalization", () => {
  it("preserves values and measures the exact expanded UTF-8 representation", () => {
    const normalized = normalizeColumnarSqlChunk(chunk, limits)!;
    expect(normalized.payload.rows).toEqual([
      { id: 1, name: "ação 🎉", amount: 1.25, large: 1234567890123 },
      { id: 2, name: null, amount: 2.5, large: 1234567890124 },
    ]);
    expect(normalized.originalSizeBytes).toBe(
      Buffer.byteLength(JSON.stringify(normalized.payload)),
    );
    expect(normalized.payload).not.toHaveProperty("columnar");
    expect(countSqlChunkRows(chunk)).toBe(2);
  });
  it("keeps existing rows authoritative without adding the columnar copy", () => {
    const normalized = normalizeColumnarSqlChunk({ ...chunk, rows: [{ old: true }] }, limits)!;
    expect(normalized.payload.rows).toEqual([{ old: true }]);
    expect(countSqlChunkRows({ ...chunk, rows: [{ old: true }] })).toBe(1);
  });
  it("leaves conventional chunks unchanged for byte-forward", () => {
    expect(normalizeColumnarSqlChunk({ rows: [{ id: 1 }] }, limits)).toBeNull();
  });
  it("allows the existing materialization budget to reject before expanding rows", () => {
    let inspected = false;
    const rejected = normalizeColumnarSqlChunk(chunk, limits, (rows, bytes) => {
      inspected = true;
      expect(rows).toBe(2);
      expect(bytes).toBeGreaterThan(90);
      return false;
    });
    expect(inspected).toBe(true);
    expect(rejected).toBeUndefined();
    expect(chunk.rows).toEqual([]);
  });
  it("rejects malformed vectors and expanded budgets before row allocation", () => {
    expect(() => normalizeColumnarSqlChunk(chunk, { ...limits, maxRows: 1 })).toThrow("row limit");
    expect(() => normalizeColumnarSqlChunk(chunk, { ...limits, maxBytes: 90 })).toThrow(
      "byte limit",
    );
    for (const columnar of [
      { row_count: -1, columns: [] },
      { row_count: 2, columns: [{ name: "id", type: "int32", values: [1] }] },
    ]) {
      expect(() => normalizeColumnarSqlChunk({ ...chunk, columnar }, limits)).toThrow();
    }
  });
  it("supports empty results, duplicate names and prototype-looking column names", () => {
    expect(
      normalizeColumnarSqlChunk({ ...chunk, columnar: { row_count: 0, columns: [] } }, limits)!
        .payload.rows,
    ).toEqual([]);
    const normalized = normalizeColumnarSqlChunk(
      {
        ...chunk,
        columnar: {
          row_count: 1,
          columns: [
            { name: "__proto__", type: "object", values: [{ safe: true }] },
            { name: "id", type: "int32", values: [1] },
            { name: "id", type: "int32", values: [2] },
          ],
        },
      },
      limits,
    )!;
    const expectedRow: Record<string, unknown> = Object.create(null);
    expectedRow.id = 2;
    Object.defineProperty(expectedRow, "__proto__", {
      value: { safe: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(JSON.parse(JSON.stringify(normalized.payload.rows))).toEqual([expectedRow]);
    expect(normalized.originalSizeBytes).toBe(
      Buffer.byteLength(JSON.stringify(normalized.payload)),
    );
  });
});
