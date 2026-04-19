import { describe, expect, it } from "vitest";

import {
  buildAgentOfflineNormalizedResponse,
  resolveBridgeRequestIdFromCommand,
} from "../../../../../src/presentation/http/serializers/agent_offline_bridge_response";

describe("buildAgentOfflineNormalizedResponse", () => {
  it("returns single JSON-RPC error with caller id", () => {
    const agentId = "3183a9f2-429b-46d6-a339-3580e5e5cb31";
    const { requestId, response } = buildAgentOfflineNormalizedResponse(agentId, {
      jsonrpc: "2.0",
      method: "rpc.discover",
      id: "disc-1",
    });

    expect(requestId).toBe("disc-1");
    expect(response).toEqual({
      type: "single",
      success: false,
      item: {
        id: "disc-1",
        success: false,
        error: {
          code: -32_000,
          message: "agent_offline",
          data: { reason: "agent_not_connected", agent_id: agentId },
        },
      },
    });
  });

  it("returns batch errors aligned to each item id", () => {
    const agentId = "11111111-1111-1111-1111-111111111111";
    const { requestId, response } = buildAgentOfflineNormalizedResponse(agentId, [
      { jsonrpc: "2.0", method: "rpc.discover", id: "a" },
      { jsonrpc: "2.0", method: "client_token.getPolicy", id: "b" },
    ]);

    expect(typeof requestId).toBe("string");
    expect(response.type).toBe("batch");
    if (response.type !== "batch") {
      return;
    }
    expect(response.success).toBe(false);
    expect(response.items).toHaveLength(2);
    expect(response.items[0]?.id).toBe("a");
    expect(response.items[1]?.id).toBe("b");
    expect(response.items[0]?.error?.code).toBe(-32_000);
  });
});

describe("resolveBridgeRequestIdFromCommand", () => {
  it("uses first correlation id for single-command batches", () => {
    expect(
      resolveBridgeRequestIdFromCommand({
        jsonrpc: "2.0",
        method: "rpc.discover",
        id: "x",
      }),
    ).toBe("x");
  });

  it("uses random UUID when batch has multiple ids", () => {
    const id = resolveBridgeRequestIdFromCommand([
      { jsonrpc: "2.0", method: "rpc.discover", id: "a" },
      { jsonrpc: "2.0", method: "rpc.discover", id: "b" },
    ]);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
