import { describe, expect, it } from "vitest";

import {
  appendSqlStreamChunkRows,
  countSqlExecuteResultRowsInEnvelope,
  countSqlStreamChunkRows,
  mergeSqlStreamRpcResponseWithAppendedRows,
  mergeSqlStreamRpcResponseWithOwnedRows,
} from "../../../../src/application/agent_commands/merge_sql_stream_rpc_response";

describe("merge_sql_stream_rpc_response counters", () => {
  it("transfers an owned accumulator without changing the envelope or nullable metadata", () => {
    const initial = {
      jsonrpc: "2.0",
      id: "r",
      result: { rows: [], stream_id: "s", affected_rows: null, metadata: { nullable: null } },
    };
    const rows = [{ id: 1 }, { id: 2 }];
    const complete = { total_rows: 20 };
    const merged = mergeSqlStreamRpcResponseWithOwnedRows(initial, rows, complete) as {
      result: { rows: unknown[] };
    };
    expect(merged).toEqual(mergeSqlStreamRpcResponseWithAppendedRows(initial, rows, complete));
    expect(merged.result.rows).toBe(rows);
    expect(initial.result.rows).toEqual([]);
    expect(initial.result.stream_id).toBe("s");
    const copied = mergeSqlStreamRpcResponseWithAppendedRows(initial, rows, complete) as {
      result: { rows: unknown[] };
    };
    expect(copied.result.rows).not.toBe(rows);
  });

  it("preserves initial row order and copies when prepending initial rows", () => {
    const initial = { result: { rows: [{ id: 0 }], stream_id: "s" } };
    const rows = [{ id: 1 }];
    const merged = mergeSqlStreamRpcResponseWithOwnedRows(initial, rows, {}) as {
      result: { rows: unknown[]; total_rows: number };
    };
    expect(merged.result.rows).toEqual([{ id: 0 }, { id: 1 }]);
    expect(merged.result.total_rows).toBe(2);
    expect(rows).toEqual([{ id: 1 }]);
    expect(initial.result.rows).toEqual([{ id: 0 }]);
  });

  it.each(["error", "aborted"])(
    "never publishes owned partial rows on terminal %s",
    (terminal_status) => {
      const rows = [{ id: 1 }];
      expect(() =>
        mergeSqlStreamRpcResponseWithOwnedRows({ result: { rows: [] } }, rows, { terminal_status }),
      ).toThrow("terminal_status");
      expect(rows).toEqual([{ id: 1 }]);
    },
  );
  it("countSqlExecuteResultRowsInEnvelope reads result.rows length", () => {
    expect(
      countSqlExecuteResultRowsInEnvelope({
        jsonrpc: "2.0",
        id: "1",
        result: { rows: [1, 2, 3], stream_id: "s" },
      }),
    ).toBe(3);
    expect(countSqlExecuteResultRowsInEnvelope({})).toBe(0);
    expect(countSqlExecuteResultRowsInEnvelope(null)).toBe(0);
  });

  it("countSqlStreamChunkRows reads chunk.rows length", () => {
    expect(countSqlStreamChunkRows({ rows: ["a", "b"] })).toBe(2);
    expect(countSqlStreamChunkRows({})).toBe(0);
  });

  it("appendSqlStreamChunkRows appends rows and returns count", () => {
    const target: unknown[] = [0];
    expect(appendSqlStreamChunkRows(target, { rows: ["a", "b"] })).toBe(2);
    expect(target).toEqual([0, "a", "b"]);
    expect(appendSqlStreamChunkRows(target, {})).toBe(0);
  });

  it("mergeSqlStreamRpcResponseWithAppendedRows merges initial and streamed rows", () => {
    const merged = mergeSqlStreamRpcResponseWithAppendedRows(
      {
        jsonrpc: "2.0",
        id: "1",
        result: {
          rows: [{ id: 1 }],
          stream_id: "stream-1",
        },
      },
      [{ id: 2 }, { id: 3 }],
      { total_rows: 3 },
    ) as { result: { rows: unknown[]; total_rows: number; stream_id?: string } };

    expect(merged.result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(merged.result.total_rows).toBe(3);
    expect("stream_id" in merged.result).toBe(false);
  });
});
