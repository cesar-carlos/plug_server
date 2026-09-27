import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";
import {
  agentRegistry,
  type RegisteredAgent,
} from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import {
  admitAgentInboundFrame,
  cleanupAgentInboundIngressSocket,
  getAgentInboundIngressMetricsSnapshot,
  resetAgentInboundIngressForTests,
} from "../../../../../src/presentation/socket/hub/relay/agent_inbound_ingress_guard";

describe("agent_inbound_ingress_guard", () => {
  afterEach(() => {
    resetAgentInboundIngressForTests();
    vi.restoreAllMocks();
  });

  const frame = encodePayloadFrame({ ok: true }, { requestId: "req-1" });

  it("observes over-budget frames without rejecting in observe mode", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("observe");
    vi.spyOn(env, "socketAgentInboundMaxFramesPerWindow", "get").mockReturnValue(1);
    const first = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(first.admitted).toBe(true);
    const second = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(second.admitted).toBe(true);
    expect(getAgentInboundIngressMetricsSnapshot().pendingWork).toBe(2);
  });

  it("continues accounting observed traffic after the first budget violation", () => {
    let mode: "observe" | "enforce" = "observe";
    let maxFrames = 1;
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockImplementation(() => mode);
    vi.spyOn(env, "socketAgentInboundMaxFramesPerWindow", "get").mockImplementation(
      () => maxFrames,
    );
    for (let index = 0; index < 2; index += 1) {
      expect(
        admitAgentInboundFrame({ socketId: "s1", event: "rpc:chunk", rawPayload: frame }).admitted,
      ).toBe(true);
    }
    mode = "enforce";
    maxFrames = 2;
    const next = admitAgentInboundFrame({ socketId: "s1", event: "rpc:chunk", rawPayload: frame });
    expect(next.admitted).toBe(false);
  });

  it("rejects over-budget frames in enforce mode", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("enforce");
    vi.spyOn(env, "socketAgentInboundMaxFramesPerWindow", "get").mockReturnValue(1);
    vi.spyOn(env, "socketAgentInboundViolationsBeforeDisconnect", "get").mockReturnValue(2);
    const first = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(first.admitted).toBe(true);
    const second = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(second.admitted).toBe(false);
    if (!second.admitted) {
      expect(second.disconnect).toBe(false);
    }
    const third = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(third.admitted).toBe(false);
    if (!third.admitted) {
      expect(third.disconnect).toBe(true);
    }
  });

  it("rejects malformed frames in enforce without consuming the frame budget", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("enforce");
    vi.spyOn(env, "socketAgentInboundMaxFramesPerWindow", "get").mockReturnValue(1);
    const invalid = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:response",
      rawPayload: { not: "a-frame" },
    });
    expect(invalid.admitted).toBe(false);
    const second = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:response",
      rawPayload: frame,
    });
    expect(second.admitted).toBe(true);
  });

  it("does not give an invalid frame pending-work credit in observe mode", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("observe");
    const admitted = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: { not: "a-frame" },
    });
    expect(admitted.admitted).toBe(true);
    expect(getAgentInboundIngressMetricsSnapshot().pendingWork).toBe(0);
  });

  it("counts rejected decoded bytes instead of frame events", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("enforce");
    vi.spyOn(env, "socketAgentInboundMaxDecodedBytesPerWindow", "get").mockReturnValue(
      frame.originalSize,
    );
    const first = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(first.admitted).toBe(true);
    const second = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(second.admitted).toBe(false);
    expect(getAgentInboundIngressMetricsSnapshot().bytesRejectedDecoded).toBe(frame.originalSize);
  });

  const registeredAgent = (socketId: string, agentId = "agent-shared"): RegisteredAgent => ({
    agentId,
    socketId,
    userId: null,
    capabilities: {},
    connectedAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2020-01-01T00:00:00.000Z",
  });

  it("shares the enforce frame cap across sockets of the same registered agentId", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("enforce");
    vi.spyOn(env, "socketAgentInboundMaxFramesPerWindow", "get").mockReturnValue(1);
    vi.spyOn(agentRegistry, "findBySocketId").mockImplementation((socketId: string) => {
      if (socketId === "s1" || socketId === "s2") {
        return registeredAgent(socketId);
      }
      return null;
    });
    const first = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(first.admitted).toBe(true);
    const second = admitAgentInboundFrame({
      socketId: "s2",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(second.admitted).toBe(false);
    if (!second.admitted) {
      expect(second.reason).toBe("frames");
    }
  });

  it("does not consume a registered agent budget from an unregistered socket", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("enforce");
    vi.spyOn(env, "socketAgentInboundMaxFramesPerWindow", "get").mockReturnValue(1);
    vi.spyOn(agentRegistry, "findBySocketId").mockImplementation((socketId: string) => {
      return socketId === "s1" ? registeredAgent("s1") : null;
    });
    const registered = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(registered.admitted).toBe(true);
    const unregistered = admitAgentInboundFrame({
      socketId: "s-unregistered",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(unregistered.admitted).toBe(true);
  });

  it("drops both socket and agent ingress keys when the last mapped socket disconnects", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("enforce");
    vi.spyOn(env, "socketAgentInboundMaxFramesPerWindow", "get").mockReturnValue(1);
    vi.spyOn(agentRegistry, "findBySocketId").mockImplementation((socketId: string) => {
      if (socketId === "s1" || socketId === "s2") {
        return registeredAgent(socketId);
      }
      return null;
    });
    const first = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(first.admitted).toBe(true);
    cleanupAgentInboundIngressSocket("s1");
    const afterCleanup = admitAgentInboundFrame({
      socketId: "s2",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(afterCleanup.admitted).toBe(true);
  });

  it("does not release another socket's pending budget after a disconnected job completes", () => {
    vi.spyOn(env, "socketAgentInboundGuardMode", "get").mockReturnValue("enforce");
    vi.spyOn(env, "socketAgentInboundMaxPendingWork", "get").mockReturnValue(1);
    vi.spyOn(agentRegistry, "findBySocketId").mockImplementation((socketId: string) =>
      socketId === "s1" || socketId === "s2" ? registeredAgent(socketId) : null,
    );
    const disconnected = admitAgentInboundFrame({
      socketId: "s1",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(disconnected.admitted).toBe(true);
    cleanupAgentInboundIngressSocket("s1");
    const active = admitAgentInboundFrame({
      socketId: "s2",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(active.admitted).toBe(true);
    if (disconnected.admitted) {
      disconnected.release();
    }
    expect(getAgentInboundIngressMetricsSnapshot().pendingWork).toBe(1);
    const overBudget = admitAgentInboundFrame({
      socketId: "s2",
      event: "rpc:chunk",
      rawPayload: frame,
    });
    expect(overBudget.admitted).toBe(false);
    if (active.admitted) {
      active.release();
    }
  });
});
