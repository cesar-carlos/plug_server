import { afterEach, expect, it, vi } from "vitest";
import { createDispatchRpcCommandToAgent } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_command";
import { createRpcBridgeRelayDispatch } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_relay";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/registries/conversation_registry";
import { resetRestPendingRequestsStore } from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetRelayRequestRegistry } from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetRelayIdempotencyStore } from "../../../../../src/presentation/socket/hub/registries/relay_idempotency_store";
import { env } from "../../../../../src/shared/config/env";
import { overrideEnv } from "../../../../helpers/override_env";
import { bridgeSingleCommandSchema } from "../../../../../src/shared/validators/agent_command";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

const original = env.enableActionIoHomologation;
const register = (socketId: string): void => {
  agentRegistry.registerAgentSession({
    agentId: "agent",
    socketId,
    userId: "user",
    policy: "legacy_silent_takeover",
    isPeerConnected: () => false,
    capabilities: {
      protocols: ["jsonrpc-v2"],
      encodings: ["json"],
      compressions: ["none"],
      extensions: { agentActions: { deadlineClock: 1 } },
    },
  });
  agentRegistry.touch("agent", { markProtocolReady: true, socketId });
};
afterEach(() => {
  agentRegistry.clear();
  conversationRegistry.clear();
  resetRestPendingRequestsStore();
  resetRelayRequestRegistry();
  resetRelayIdempotencyStore();
  overrideEnv("enableActionIoHomologation", original);
});
for (const transport of ["command", "relay", "notification"] as const) {
  it.each(["getExecution", "cancel"])(
    `refuses %s on ${transport} if the session changes during the probe`,
    async (method) => {
      overrideEnv("enableActionIoHomologation", true);
      register("socket");
      const emit = vi.fn();
      const socket = {
        emit,
        timeout: () => ({
          emitWithAck: async () => {
            register("replacement");
            return { version: 1, clock_id: "old-session", monotonic_ms: 100 };
          },
        }),
      };
      const command = bridgeSingleCommandSchema.parse({
        id: transport === "notification" ? null : "control",
        method: `agent.action.${method}`,
        params: { execution_id: "e" },
      });
      const deps = {
        hasRegisteredAgentSocketBridge: () => true,
        findAgentSocketById: () => socket,
      };
      let pending: Promise<unknown>;
      if (transport !== "relay")
        pending = createDispatchRpcCommandToAgent(deps)({ agentId: "agent", command });
      else {
        conversationRegistry.create({
          conversationId: "conversation",
          consumerSocketId: "consumer",
          agentSocketId: "socket",
          agentId: "agent",
        });
        pending = createRpcBridgeRelayDispatch({
          ...deps,
          emitToConsumer: vi.fn(),
          prepareAgentStreamPull: () => {
            throw new Error("Not a stream");
          },
        }).dispatchRelayRpcToAgent({
          conversationId: "conversation",
          consumerSocketId: "consumer",
          rawFramePayload: encodePayloadFrame(command),
        });
      }
      await expect(pending).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        details: { reason: "session_changed" },
      });
      expect(emit).not.toHaveBeenCalled();
    },
  );
}
