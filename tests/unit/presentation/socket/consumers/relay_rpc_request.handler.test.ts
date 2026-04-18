import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/application/services/bridge_latency_trace_builder", () => ({
  createBridgeLatencyTraceIfSampled: vi.fn(() => null),
}));

vi.mock("../../../../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/rpc_bridge", () => ({
  dispatchRelayRpcToAgent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/conversation_registry", () => ({
  conversationRegistry: {
    findInternalByConversationId: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
  resolveSocketActorRole: vi.fn(() => "user"),
}));

vi.mock("../../../../../src/presentation/socket/consumers/per_socket_inflight_gate", () => ({
  tryAcquireSocketInflightSlot: vi.fn(() => true),
  releaseSocketInflightSlot: vi.fn(),
}));

import { dispatchRelayRpcToAgent } from "../../../../../src/presentation/socket/hub/rpc_bridge";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/conversation_registry";
import { handleRelayRpcRequest } from "../../../../../src/presentation/socket/consumers/relay_rpc_request.handler";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";

const mockedDispatchRelayRpcToAgent = vi.mocked(dispatchRelayRpcToAgent);
const mockedFindConversation = vi.mocked(conversationRegistry.findInternalByConversationId);
const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);

const buildSocket = () =>
  ({
    id: "consumer-1",
    data: {
      user: {
        sub: "user-1",
        principal_type: "user",
        role: "user",
      },
    },
    emit: vi.fn(),
  }) as const;

describe("handleRelayRpcRequest", () => {
  beforeEach(() => {
    mockedDispatchRelayRpcToAgent.mockReset();
    mockedFindConversation.mockReset();
    mockedAssertAccess.mockReset();

    mockedFindConversation.mockReturnValue({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentId: "agent-1",
      agentSocketId: "agent-socket-1",
      createdAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
    });
    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
  });

  it("emits VALIDATION_ERROR for malformed envelopes", () => {
    const socket = buildSocket();

    handleRelayRpcRequest(socket as never, { conversationId: "" });

    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.relayRpcAccepted,
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
      }),
    );
  });

  it("surfaces deduplicated in-flight accepts to the consumer", async () => {
    const socket = buildSocket();
    mockedDispatchRelayRpcToAgent.mockResolvedValue({
      requestId: "req-original",
      clientRequestId: "client-req-1",
      deduplicated: true,
      inFlight: true,
    });

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayRpcAccepted, {
        success: true,
        conversationId: "conv-1",
        requestId: "req-original",
        clientRequestId: "client-req-1",
        deduplicated: true,
        inFlight: true,
      });
    });
  });
});
