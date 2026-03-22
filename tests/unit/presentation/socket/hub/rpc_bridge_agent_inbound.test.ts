import { describe, expect, it, vi } from "vitest";

import { createRpcBridgeAgentInboundHandlers } from "../../../../../src/presentation/socket/hub/rpc_bridge_agent_inbound";

describe("rpc_bridge_agent_inbound", () => {
  it("createRpcBridgeAgentInboundHandlers returns all inbound handlers", () => {
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });
    expect(typeof h.handleAgentRpcResponse).toBe("function");
    expect(typeof h.handleAgentRpcChunk).toBe("function");
    expect(typeof h.handleAgentRpcComplete).toBe("function");
    expect(typeof h.handleAgentRpcAck).toBe("function");
    expect(typeof h.handleAgentBatchAck).toBe("function");
  });

  it("should invoke Socket.IO ack on rpc:response decode failure (delivery guarantee compat)", async () => {
    const ack = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });
    h.handleAgentRpcResponse("socket-test", "not-a-payload-frame", ack);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
  });
});
