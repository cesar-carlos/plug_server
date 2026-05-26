import type { Namespace } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumerRegistry } from "../../../../../src/presentation/socket/hub/registries/consumer_registry";
import {
  startConsumerIdleTimeoutScheduler,
  stopConsumerIdleTimeoutScheduler,
  sweepIdleConsumerConnections,
} from "../../../../../src/presentation/socket/hub/scheduling/consumer_idle_timeout_scheduler";
import {
  getSocketConsumerMetricsSnapshot,
  resetSocketConsumerMetrics,
} from "../../../../../src/shared/metrics/socket_consumer.metrics";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

const disconnect = vi.fn();
const emit = vi.fn();

const mockSockets = new Map<
  string,
  { connected: boolean; disconnect: typeof disconnect; emit: typeof emit }
>();

const mockNamespace = {
  sockets: mockSockets,
} as unknown as Namespace;

vi.mock("../../../../../src/shared/config/env", () => ({
  env: {
    socketConsumerIdleTimeoutMs: 60_000,
    socketConsumerIdleSweepIntervalMs: 1_000,
  },
}));

describe("consumer_idle_timeout_scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSocketConsumerMetrics();
    consumerRegistry.clear();
    disconnect.mockReset();
    emit.mockReset();
    mockSockets.clear();
    stopConsumerIdleTimeoutScheduler();
    startConsumerIdleTimeoutScheduler(mockNamespace);
  });

  afterEach(() => {
    stopConsumerIdleTimeoutScheduler();
    vi.useRealTimers();
    consumerRegistry.clear();
  });

  it("disconnects connected consumers idle longer than the threshold", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    consumerRegistry.registerSession({
      socketId: "sock-idle",
      userId: "user-1",
      principalType: "user",
    });

    mockSockets.set("sock-idle", { connected: true, disconnect, emit });

    vi.setSystemTime(new Date("2026-05-08T10:02:00.000Z"));
    const disconnected = sweepIdleConsumerConnections();

    expect(disconnected).toBe(1);
    expect(emit).toHaveBeenCalledWith(
      socketEvents.appError,
      expect.objectContaining({ code: "CONSUMER_IDLE_TIMEOUT" }),
    );
    expect(disconnect).toHaveBeenCalledWith(true);
    expect(getSocketConsumerMetricsSnapshot().consumerIdleTimeoutDisconnectTotal).toBe(1);
  });

  it("skips consumers that are still within the idle threshold", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    consumerRegistry.registerSession({
      socketId: "sock-active",
      userId: "user-1",
      principalType: "user",
    });
    mockSockets.set("sock-active", { connected: true, disconnect, emit });

    vi.setSystemTime(new Date("2026-05-08T10:00:30.000Z"));
    expect(sweepIdleConsumerConnections()).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("runs periodic sweeps until stopped", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    consumerRegistry.registerSession({
      socketId: "sock-timer",
      userId: "user-1",
      principalType: "user",
    });
    mockSockets.set("sock-timer", { connected: true, disconnect, emit });

    startConsumerIdleTimeoutScheduler(mockNamespace);
    vi.setSystemTime(new Date("2026-05-08T10:02:00.000Z"));
    vi.advanceTimersByTime(1_000);

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
