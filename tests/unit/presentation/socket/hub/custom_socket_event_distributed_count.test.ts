import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialDistributedCountCircuitState } from "../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit";

vi.mock("../../../../../src/infrastructure/redis/adapter/socket_io_redis_adapter", () => ({
  isSocketIoRedisAdapterActive: vi.fn(() => true),
}));

const setMaxRecipients = (value: number): void => {
  process.env["REST_SOCKET_EVENT_MAX_RECIPIENTS"] = String(value);
};

const restoreMaxRecipients = (): void => {
  delete process.env["REST_SOCKET_EVENT_MAX_RECIPIENTS"];
};

const importEnvFresh = async (): Promise<void> => {
  vi.resetModules();
  await import("../../../../../src/shared/config/env");
};

describe("countDistributedRoomRecipients (dedupe path)", () => {
  afterEach(() => {
    restoreMaxRecipients();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("returns fetchedSockets when fetchDistributedSockets is provided and strategy fetches", async () => {
    setMaxRecipients(256);
    await importEnvFresh();
    const { countDistributedRoomRecipients: fn } =
      await import("../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit");

    const sockets = [{ data: { user: { sub: "p1" } } }, { data: { user: { sub: "p2" } } }];
    const fetchSockets = vi.fn().mockResolvedValue(sockets);

    const result = await fn({
      circuit: createInitialDistributedCountCircuitState(),
      localRecipients: 2,
      room: "room:test",
      fetchDistributedSockets: fetchSockets,
      onCircuitReset: vi.fn(),
    });

    expect(fetchSockets).toHaveBeenCalledTimes(1);
    expect(result.recipients).toBe(2);
    expect(result.fetchedSockets).toBe(sockets);
    expect(result.recipientCountBestEffort).toBe(false);
  });

  it("does NOT call fetchDistributedSockets when strategy is local_only (maxRecipients=0)", async () => {
    setMaxRecipients(0);
    await importEnvFresh();
    const { countDistributedRoomRecipients: fn } =
      await import("../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit");

    const fetchSockets = vi.fn();
    const result = await fn({
      circuit: createInitialDistributedCountCircuitState(),
      localRecipients: 5,
      room: "room:local",
      fetchDistributedSockets: fetchSockets,
      onCircuitReset: vi.fn(),
    });

    expect(fetchSockets).not.toHaveBeenCalled();
    expect(result.recipients).toBe(5);
    expect(result.fetchedSockets).toBeUndefined();
  });

  it("does NOT call fetchDistributedSockets when local count already exceeds the cap", async () => {
    setMaxRecipients(10);
    await importEnvFresh();
    const { countDistributedRoomRecipients: fn } =
      await import("../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit");

    const fetchSockets = vi.fn();
    const result = await fn({
      circuit: createInitialDistributedCountCircuitState(),
      localRecipients: 50,
      room: "room:overcap",
      fetchDistributedSockets: fetchSockets,
      onCircuitReset: vi.fn(),
    });

    expect(fetchSockets).not.toHaveBeenCalled();
    expect(result.recipients).toBe(50);
    expect(result.fetchedSockets).toBeUndefined();
  });

  it("falls back to local count and best-effort flag when fetchDistributedSockets throws", async () => {
    setMaxRecipients(256);
    await importEnvFresh();
    const { countDistributedRoomRecipients: fn } =
      await import("../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit");

    const fetchSockets = vi.fn().mockRejectedValue(new Error("cluster slow"));
    const onCircuitReset = vi.fn();
    const result = await fn({
      circuit: createInitialDistributedCountCircuitState(),
      localRecipients: 7,
      room: "room:err",
      fetchDistributedSockets: fetchSockets,
      onCircuitReset,
    });

    expect(fetchSockets).toHaveBeenCalledTimes(1);
    expect(result.recipients).toBe(7);
    expect(result.recipientCountBestEffort).toBe(true);
    expect(result.fetchedSockets).toBeUndefined();
  });

  it("legacy fetchDistributedCount path still works (returns count only, no sockets)", async () => {
    setMaxRecipients(256);
    await importEnvFresh();
    const { countDistributedRoomRecipients: fn } =
      await import("../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit");

    const fetchCount = vi.fn().mockResolvedValue(11);
    const result = await fn({
      circuit: createInitialDistributedCountCircuitState(),
      localRecipients: 3,
      room: "room:legacy",
      fetchDistributedCount: fetchCount,
      onCircuitReset: vi.fn(),
    });

    expect(fetchCount).toHaveBeenCalledTimes(1);
    expect(result.recipients).toBe(11);
    expect(result.fetchedSockets).toBeUndefined();
  });
});

describe("countDistributedRoomRecipients (parallel init prerequisites)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  it("module imports without side effects (parallel init safe)", async () => {
    const mod =
      await import("../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit");
    expect(typeof mod.countDistributedRoomRecipients).toBe("function");
  });
});
