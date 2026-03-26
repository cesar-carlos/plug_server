import { describe, expect, it } from "vitest";

import {
  countSqlExecuteResultRowsInEnvelope,
  countSqlStreamChunkRows,
} from "../../../../src/application/agent_commands/merge_sql_stream_rpc_response";

describe("merge_sql_stream_rpc_response counters", () => {
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
});
