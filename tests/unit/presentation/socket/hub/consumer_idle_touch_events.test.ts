import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumerRegistry } from "../../../../../src/presentation/socket/hub/registries/consumer_registry";
import {
  consumerIdleTouchEvents,
  isConsumerIdleTouchEvent,
  touchConsumerRegistryOnInboundEvent,
} from "../../../../../src/presentation/socket/hub/scheduling/consumer_idle_touch_events";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

describe("consumer_idle_touch_events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    consumerRegistry.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    consumerRegistry.clear();
  });

  it("documents the allowlist of meaningful idle-touch events", () => {
    expect([...consumerIdleTouchEvents]).toEqual([
      socketEvents.agentsCommand,
      socketEvents.agentsStreamPull,
      socketEvents.relayConversationStart,
      socketEvents.relayConversationEnd,
      socketEvents.relayRpcRequest,
      socketEvents.relayRpcStreamPull,
      socketEvents.socketEventSubscribe,
      socketEvents.socketEventUnsubscribe,
      socketEvents.socketEventPublish,
    ]);
  });

  it("accepts only allowlisted inbound events", () => {
    for (const eventName of consumerIdleTouchEvents) {
      expect(isConsumerIdleTouchEvent(eventName)).toBe(true);
    }

    const noiseEvents = [
      socketEvents.relayRpcStreamPullResponse,
      socketEvents.relayRpcChunk,
      socketEvents.relayRpcComplete,
      socketEvents.relayRpcResponse,
      socketEvents.agentsCommandStreamChunk,
      socketEvents.agentsCommandResponse,
      socketEvents.clientAgentProfileUpdated,
      socketEvents.connectionReady,
      socketEvents.appError,
      "disconnect",
      "unknown:event",
    ];

    for (const eventName of noiseEvents) {
      expect(isConsumerIdleTouchEvent(eventName)).toBe(false);
    }
  });

  it("touches the registry only for allowlisted events", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    consumerRegistry.registerSession({
      socketId: "sock-1",
      userId: "user-1",
      principalType: "user",
    });

    vi.setSystemTime(new Date("2026-05-08T10:02:00.000Z"));
    expect(touchConsumerRegistryOnInboundEvent("sock-1", socketEvents.relayRpcChunk)).toBeNull();

    vi.setSystemTime(new Date("2026-05-08T10:03:00.000Z"));
    const touched = touchConsumerRegistryOnInboundEvent("sock-1", socketEvents.agentsCommand);
    expect(touched?.lastSeenAt).toBe("2026-05-08T10:03:00.000Z");

    const idle = consumerRegistry.listIdle(60_000);
    expect(idle).toHaveLength(0);
  });

  it("does not touch unknown sockets even for allowlisted events", () => {
    expect(touchConsumerRegistryOnInboundEvent("missing", socketEvents.agentsCommand)).toBeNull();
  });
});
