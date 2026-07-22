import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumerRegistry } from "../../../../../src/presentation/socket/hub/registries/consumer_registry";
import {
  consumerIdleTouchEvents,
  isConsumerIdleTouchEvent,
  resetConsumerIdleTouchDebounceState,
  touchConsumerRegistryOnInboundEvent,
  touchConsumerRegistryOnSocketActivity,
} from "../../../../../src/presentation/socket/hub/scheduling/consumer_idle_touch_events";
import { env } from "../../../../../src/shared/config/env";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

describe("consumer_idle_touch_events", () => {
  const originalDebounceMs = env.socketConsumerIdleTouchDebounceMs;

  beforeEach(() => {
    vi.useFakeTimers();
    consumerRegistry.clear();
    resetConsumerIdleTouchDebounceState();
    env.socketConsumerIdleTouchDebounceMs = originalDebounceMs;
  });

  afterEach(() => {
    vi.useRealTimers();
    consumerRegistry.clear();
    resetConsumerIdleTouchDebounceState();
    env.socketConsumerIdleTouchDebounceMs = originalDebounceMs;
  });

  it("documents the allowlist of meaningful idle-touch events", () => {
    expect([...consumerIdleTouchEvents]).toEqual([
      socketEvents.agentsCommand,
      socketEvents.agentsStreamPull,
      socketEvents.relayConversationStart,
      socketEvents.relayConversationEnd,
      socketEvents.relayRpcRequest,
      socketEvents.relayRpcRequestBatch,
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

  it("touchConsumerRegistryOnSocketActivity refreshes lastSeenAt for registered sockets", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    consumerRegistry.registerSession({
      socketId: "sock-activity",
      userId: "user-1",
      principalType: "user",
    });

    vi.setSystemTime(new Date("2026-05-08T10:04:00.000Z"));
    const touched = touchConsumerRegistryOnSocketActivity("sock-activity");
    expect(touched?.lastSeenAt).toBe("2026-05-08T10:04:00.000Z");
  });

  it("debounces registry touches within the configured window", () => {
    env.socketConsumerIdleTouchDebounceMs = 5_000;
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    consumerRegistry.registerSession({
      socketId: "sock-debounce",
      userId: "user-1",
      principalType: "user",
    });

    vi.setSystemTime(new Date("2026-05-08T10:01:00.000Z"));
    expect(touchConsumerRegistryOnSocketActivity("sock-debounce")?.lastSeenAt).toBe(
      "2026-05-08T10:01:00.000Z",
    );

    vi.setSystemTime(new Date("2026-05-08T10:01:02.000Z"));
    expect(touchConsumerRegistryOnSocketActivity("sock-debounce")).toBeNull();

    vi.setSystemTime(new Date("2026-05-08T10:01:06.000Z"));
    expect(touchConsumerRegistryOnSocketActivity("sock-debounce")?.lastSeenAt).toBe(
      "2026-05-08T10:01:06.000Z",
    );
  });

  it("debounce 0 preserves every-touch behavior", () => {
    env.socketConsumerIdleTouchDebounceMs = 0;
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    consumerRegistry.registerSession({
      socketId: "sock-every",
      userId: "user-1",
      principalType: "user",
    });

    vi.setSystemTime(new Date("2026-05-08T10:01:00.000Z"));
    touchConsumerRegistryOnSocketActivity("sock-every");
    vi.setSystemTime(new Date("2026-05-08T10:01:01.000Z"));
    const touched = touchConsumerRegistryOnSocketActivity("sock-every");
    expect(touched?.lastSeenAt).toBe("2026-05-08T10:01:01.000Z");
  });
});
