import { describe, expect, it } from "vitest";
import { persistRelayIdempotentResponseFrame } from "../../../../src/presentation/socket/hub/relay/rpc_bridge_relay_route_helpers";
import { getRelayIdempotencyMap } from "../../../../src/presentation/socket/hub/registries/relay_idempotency_store";
import { mayCacheActionResponse } from "../../../../src/application/agent_commands/action_io_method_policy";
describe("mutable action response cache exclusion", () => {
  it.each([
    "run",
    "validateRun",
    "getExecution",
    "cancel",
    "sendInput",
    "closeInput",
    "getInputStatus",
    "readIo",
    "findExecution",
  ])("never persists %s responses", (name) => {
    const method = `agent.action.${name}`;
    const timeoutHandle = setTimeout(() => {}, 60000);
    try {
      expect(mayCacheActionResponse(method)).toBe(false);
      const conversationId = `no-cache-${name}`;
      expect(
        persistRelayIdempotentResponseFrame(
          {
            requestId: "r",
            conversationId,
            consumerSocketId: "c",
            agentSocketId: "a",
            agentId: "agent",
            jsonRpcMethod: method,
            timeoutHandle,
            createdAtMs: Date.now(),
            clientRequestId: "caller",
          },
          { result: "changing" },
        ),
      ).toBeUndefined();
      expect(getRelayIdempotencyMap(conversationId)).toBeUndefined();
    } finally {
      clearTimeout(timeoutHandle);
    }
  });
  it("preserves the existing policy for unrelated methods", () => {
    expect(mayCacheActionResponse("agent.getHealth")).toBe(true);
  });
});
