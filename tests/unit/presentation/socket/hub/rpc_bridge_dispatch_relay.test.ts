import { describe, expect, it } from "vitest";

import { createRpcBridgeRelayDispatch } from "../../../../../src/presentation/socket/hub/rpc_bridge_dispatch_relay";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

describe("rpc_bridge_dispatch_relay", () => {
  it("rejects JSON-RPC notifications (`id: null`) in relay:rpc.request", async () => {
    const handlers = createRpcBridgeRelayDispatch({
      getAgentsNamespace: () => null,
      emitToConsumer: () => {
        /* not reached in this test */
      },
      requestAgentStreamPull: () => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 1,
      }),
    });

    const run = handlers.dispatchRelayRpcToAgent({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      rawFramePayload: encodePayloadFrame({
        jsonrpc: "2.0",
        method: "sql.execute",
        id: null,
        params: {
          sql: "SELECT 1",
        },
      }),
    });

    await expect(run).rejects.toThrow(/does not support JSON-RPC notifications/i);
  });
});
