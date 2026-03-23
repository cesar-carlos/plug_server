import { describe, expect, it } from "vitest";

import { mergeSqlStreamRpcResponse } from "../../../../src/application/agent_commands/merge_sql_stream_rpc_response";

describe("mergeSqlStreamRpcResponse", () => {
  it("should concatenate rows from initial response and chunks", () => {
    const merged = mergeSqlStreamRpcResponse(
      {
        jsonrpc: "2.0",
        id: "r1",
        result: {
          stream_id: "s1",
          rows: [{ a: 1 }],
        },
      },
      [{ chunk_index: 0, rows: [{ a: 2 }, { a: 3 }] }],
      { stream_id: "s1", request_id: "r1", total_rows: 3 },
    ) as Record<string, unknown>;

    expect(merged.result).toEqual({
      rows: [{ a: 1 }, { a: 2 }, { a: 3 }],
      total_rows: 3,
    });
  });

  it("should drop stream_id from merged result", () => {
    const merged = mergeSqlStreamRpcResponse(
      { jsonrpc: "2.0", id: "r1", result: { stream_id: "s1", rows: [] } },
      [],
      { total_rows: 0 },
    ) as Record<string, unknown>;
    const result = merged.result as Record<string, unknown>;
    expect(result.stream_id).toBeUndefined();
  });

  it("should return initial payload when not a JSON-RPC result object", () => {
    const raw = { not: "rpc" };
    expect(mergeSqlStreamRpcResponse(raw, [], {})).toBe(raw);
  });

  it("should merge row arrays larger than typical spread limits without throwing", () => {
    const n = 70_000;
    const bigChunkRows = Array.from({ length: n }, (_, i) => ({ i }));
    const merged = mergeSqlStreamRpcResponse(
      { jsonrpc: "2.0", id: "r1", result: { stream_id: "s1", rows: [] } },
      [{ rows: bigChunkRows }],
      { total_rows: n },
    ) as Record<string, unknown>;
    const result = merged.result as Record<string, unknown>;
    const rows = result.rows as Array<{ i: number }>;
    expect(rows).toHaveLength(n);
    expect(rows[0]).toEqual({ i: 0 });
    expect(rows[n - 1]).toEqual({ i: n - 1 });
  });
});
