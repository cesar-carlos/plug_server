import { describe, expect, it } from "vitest";

import { normalizeAgentRpcResponse } from "../../../../../src/presentation/http/serializers/agent_rpc_response.serializer";

describe("normalizeAgentRpcResponse", () => {
  it("returns a normalized single success response with envelope metadata", () => {
    const normalized = normalizeAgentRpcResponse({
      jsonrpc: "2.0",
      id: "req-1",
      result: { ok: true },
      api_version: "2.5",
      meta: { trace_id: "trace-1" },
    });

    expect(normalized).toEqual({
      type: "single",
      success: true,
      api_version: "2.5",
      meta: { trace_id: "trace-1" },
      item: {
        id: "req-1",
        success: true,
        result: { ok: true },
        api_version: "2.5",
        meta: { trace_id: "trace-1" },
      },
    });
  });

  it("normalizes malformed rpc error payloads to a safe default", () => {
    const normalized = normalizeAgentRpcResponse({
      jsonrpc: "2.0",
      id: 10,
      error: "boom",
    });

    expect(normalized).toEqual({
      type: "single",
      success: false,
      item: {
        id: 10,
        success: false,
        error: {
          code: -32603,
          message: "Invalid RPC error payload",
        },
      },
    });
  });

  it("converts responses without result or error into a normalized failure item", () => {
    const normalized = normalizeAgentRpcResponse({
      jsonrpc: "2.0",
      id: "req-missing",
    });

    expect(normalized).toEqual({
      type: "single",
      success: false,
      item: {
        id: "req-missing",
        success: false,
        error: {
          code: -32603,
          message: "RPC response missing both result and error",
        },
      },
    });
  });

  it("keeps valid batch items, drops invalid ones, and marks mixed success correctly", () => {
    const normalized = normalizeAgentRpcResponse([
      {
        jsonrpc: "2.0",
        id: "ok-item",
        result: { rows: 1 },
      },
      {
        jsonrpc: "2.0",
        id: "err-item",
        error: {
          code: -32000,
          message: "Agent failed",
          data: { retryable: false },
        },
      },
      "invalid-item",
    ]);

    expect(normalized).toEqual({
      type: "batch",
      success: false,
      items: [
        {
          id: "ok-item",
          success: true,
          result: { rows: 1 },
        },
        {
          id: "err-item",
          success: false,
          error: {
            code: -32000,
            message: "Agent failed",
            data: { retryable: false },
          },
        },
      ],
    });
  });

  it("returns raw failure when a batch contains no normalizable items", () => {
    const payload = ["bad", null];

    const normalized = normalizeAgentRpcResponse(payload);

    expect(normalized).toEqual({
      type: "raw",
      success: false,
      payload,
    });
  });
});
