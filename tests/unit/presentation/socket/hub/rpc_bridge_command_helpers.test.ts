import { describe, expect, it } from "vitest";

import type { BridgeCommand } from "../../../../../src/shared/validators/agent_command";
import {
  clampCommandMaxRows,
  countBatchItems,
  extractStreamIdFromRpcResponse,
  hasNotificationCommand,
  isBatchCommand,
  pickResponseIds,
  resolveOutboundApiVersion,
  toCorrelationIds,
  withBridgeMeta,
} from "../../../../../src/presentation/socket/hub/rpc_bridge_command_helpers";

describe("rpc_bridge_command_helpers", () => {
  it("pickResponseIds collects ids from batch and single responses", () => {
    expect(pickResponseIds({ id: "a" })).toEqual(["a"]);
    expect(pickResponseIds([{ id: "1" }, { id: 2 }, { foo: 1 }])).toEqual(["1", "2"]);
    expect(pickResponseIds(null)).toEqual([]);
  });

  it("isBatchCommand and toCorrelationIds", () => {
    const single: BridgeCommand = { jsonrpc: "2.0", method: "rpc.discover", id: "s1" };
    const batch: BridgeCommand = [
      { jsonrpc: "2.0", method: "rpc.discover", id: "b1" },
      { jsonrpc: "2.0", method: "rpc.discover", id: "b2" },
    ];
    expect(isBatchCommand(single)).toBe(false);
    expect(isBatchCommand(batch)).toBe(true);
    expect(toCorrelationIds(single)).toEqual(["s1"]);
    expect(toCorrelationIds(batch)).toEqual(["b1", "b2"]);
  });

  it("resolveOutboundApiVersion trims or defaults to 2.5", () => {
    expect(resolveOutboundApiVersion({ api_version: "  3.0  " })).toBe("3.0");
    expect(resolveOutboundApiVersion({ api_version: "" })).toBe("2.5");
    expect(resolveOutboundApiVersion({})).toBe("2.5");
  });

  it("withBridgeMeta preserves per-item api_version in batch", () => {
    const batch: BridgeCommand = [
      { jsonrpc: "2.0", method: "rpc.discover", id: "i1", api_version: "3" },
      { jsonrpc: "2.0", method: "rpc.discover", id: "i2" },
    ];
    const meta = {
      requestId: "bridge-r",
      agentId: "agent-1",
      traceId: "trace-1",
      timestamp: "t0",
    };
    const out = withBridgeMeta(batch, meta);
    expect(Array.isArray(out)).toBe(true);
    if (!Array.isArray(out)) {
      return;
    }
    expect(out[0].api_version).toBe("3");
    expect(out[0].meta).toMatchObject({
      request_id: "i1",
      agent_id: "agent-1",
      trace_id: "trace-1",
      timestamp: "t0",
    });
    expect(out[1].api_version).toBe("2.5");
    expect(out[1].meta?.request_id).toBe("i2");
  });

  it("withBridgeMeta merges meta on single command", () => {
    const cmd: BridgeCommand = {
      jsonrpc: "2.0",
      method: "rpc.discover",
      id: "rid",
      api_version: "2.5",
      meta: { existing: true },
    };
    const out = withBridgeMeta(cmd, {
      requestId: "rid",
      agentId: "a",
      traceId: "tr",
      timestamp: "ts",
    });
    expect(Array.isArray(out)).toBe(false);
    if (Array.isArray(out)) {
      return;
    }
    expect(out.meta).toEqual({
      existing: true,
      request_id: "rid",
      agent_id: "a",
      timestamp: "ts",
      trace_id: "tr",
    });
  });

  it("extractStreamIdFromRpcResponse reads result.stream_id", () => {
    expect(extractStreamIdFromRpcResponse({ result: { stream_id: " sid " } })).toBe("sid");
    expect(extractStreamIdFromRpcResponse({ result: {} })).toBeNull();
    expect(extractStreamIdFromRpcResponse(null)).toBeNull();
  });

  it("clampCommandMaxRows caps sql max_rows for single and batch commands", () => {
    const single: BridgeCommand = {
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "s1",
      params: {
        sql: "SELECT 1",
        options: { max_rows: 2000 },
      },
    };
    const singleOut = clampCommandMaxRows(single, 1000);
    expect(singleOut.adjusted).toBe(true);
    expect(Array.isArray(singleOut.command)).toBe(false);
    if (!Array.isArray(singleOut.command)) {
      expect(singleOut.command.params.options?.max_rows).toBe(1000);
    }

    const batch: BridgeCommand = [
      {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "b1",
        params: { sql: "SELECT 1", options: { max_rows: 5000 } },
      },
      {
        jsonrpc: "2.0",
        method: "rpc.discover",
        id: "b2",
      },
    ];
    const batchOut = clampCommandMaxRows(batch, 100);
    expect(batchOut.adjusted).toBe(true);
    expect(Array.isArray(batchOut.command)).toBe(true);
    if (Array.isArray(batchOut.command)) {
      expect(batchOut.command[0].method).toBe("sql.execute");
      if (batchOut.command[0].method === "sql.execute") {
        expect(batchOut.command[0].params.options?.max_rows).toBe(100);
      }
    }
  });

  it("countBatchItems and hasNotificationCommand work for single and batch", () => {
    const singleNotification: BridgeCommand = {
      jsonrpc: "2.0",
      method: "rpc.discover",
      id: null,
    };
    const batch: BridgeCommand = [
      { jsonrpc: "2.0", method: "rpc.discover", id: "b1" },
      { jsonrpc: "2.0", method: "sql.cancel", id: null, params: { request_id: "r1" } },
    ];

    expect(countBatchItems(singleNotification)).toBe(1);
    expect(countBatchItems(batch)).toBe(2);
    expect(hasNotificationCommand(singleNotification)).toBe(true);
    expect(hasNotificationCommand(batch)).toBe(true);
  });
});
