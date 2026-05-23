import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "socket.io";

import type * as SocketIoRedisAdapterModule from "../../../../src/infrastructure/redis/socket_io_redis_adapter";
import type * as SocketIoRedisAdapterMetricsModule from "../../../../src/application/services/socket_io_redis_adapter_metrics.service";

const setupAdapterModule = async (options?: {
  readonly nodeEnv?: "development" | "test" | "production";
  readonly redisUrl?: string;
  readonly redisAdapterRequired?: boolean;
}): Promise<{
  readonly pubClient: {
    readonly on: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly quit: ReturnType<typeof vi.fn>;
    readonly duplicate: ReturnType<typeof vi.fn>;
  };
  readonly subClient: {
    readonly on: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly quit: ReturnType<typeof vi.fn>;
  };
  readonly createClientMock: ReturnType<typeof vi.fn>;
  readonly createAdapterMock: ReturnType<typeof vi.fn>;
  readonly io: Server;
  readonly module: typeof SocketIoRedisAdapterModule;
}> => {
  vi.resetModules();

  const subClient = {
    on: vi.fn(() => subClient),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  };
  const pubClient = {
    on: vi.fn(() => pubClient),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    duplicate: vi.fn(() => subClient),
  };
  const createClientMock = vi.fn(() => pubClient);
  const createAdapterMock = vi.fn(() => vi.fn());
  const io = {
    adapter: vi.fn(),
  } as unknown as Server;

  vi.doMock("../../../../src/shared/config/env", () => ({
    env: {
      nodeEnv: options?.nodeEnv ?? "test",
      socketIoRedisAdapterUrl: options?.redisUrl ?? "redis://127.0.0.1:6379",
      socketIoRedisAdapterRequired: options?.redisAdapterRequired ?? false,
    },
  }));
  vi.doMock("redis", () => ({ createClient: createClientMock }));
  vi.doMock("@socket.io/redis-adapter", () => ({ createAdapter: createAdapterMock }));
  vi.doMock("socket.io-adapter", () => ({
    Adapter: class MemoryAdapter {},
  }));

  const module = await import("../../../../src/infrastructure/redis/socket_io_redis_adapter");
  const metrics = await import(
    "../../../../src/application/services/socket_io_redis_adapter_metrics.service"
  );
  return { pubClient, subClient, createClientMock, createAdapterMock, io, module, metrics };
};

/**
 * Unit coverage uses mocked Redis clients and fake timers for reconnect/backoff.
 * Runtime degrade → memory → reconnect against a live Redis broker is exercised in
 * `tests/integration/socket_io_redis_adapter.integration.test.ts`.
 */
describe("socket_io_redis_adapter", () => {
  let metricsModule: typeof SocketIoRedisAdapterMetricsModule;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../../../../src/shared/config/env");
    vi.doUnmock("redis");
    vi.doUnmock("@socket.io/redis-adapter");
    vi.doUnmock("socket.io-adapter");
    metricsModule = await import(
      "../../../../src/application/services/socket_io_redis_adapter_metrics.service"
    );
    metricsModule.resetSocketIoRedisAdapterMetricsForTests();
  });

  it("connects Redis adapter and marks metrics active", async () => {
    const {
      io,
      createAdapterMock,
      module: { closeSocketIoRedisAdapter, initSocketIoRedisAdapter, isSocketIoRedisAdapterActive },
      metrics,
    } = await setupAdapterModule();

    await initSocketIoRedisAdapter(io);

    expect(createAdapterMock).toHaveBeenCalledTimes(1);
    expect(io.adapter).toHaveBeenCalledTimes(1);
    expect(isSocketIoRedisAdapterActive()).toBe(true);
    expect(metrics.getSocketIoRedisAdapterMetricsSnapshot()).toMatchObject({
      redisUrlConfigured: 1,
      redisAdapterActive: 1,
      connectionEventsTotal: 1,
      fallbackEventsTotal: 0,
      attachedServersTotal: 1,
    });

    await closeSocketIoRedisAdapter();
  });

  it("falls back to in-memory adapter and schedules reconnect when connect fails", async () => {
    vi.useFakeTimers();
    const {
      io,
      pubClient,
      module: { initSocketIoRedisAdapter, isSocketIoRedisAdapterActive },
      metrics,
    } = await setupAdapterModule();
    pubClient.connect.mockRejectedValueOnce(new Error("redis unavailable"));

    await initSocketIoRedisAdapter(io);

    expect(isSocketIoRedisAdapterActive()).toBe(false);
    expect(io.adapter).toHaveBeenCalledWith(expect.any(Function));
    expect(metrics.getSocketIoRedisAdapterMetricsSnapshot()).toMatchObject({
      redisUrlConfigured: 1,
      redisAdapterActive: 0,
      fallbackEventsTotal: 1,
    });

    pubClient.connect.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runOnlyPendingTimersAsync();

    expect(isSocketIoRedisAdapterActive()).toBe(true);
    expect(metrics.getSocketIoRedisAdapterMetricsSnapshot().connectionEventsTotal).toBe(1);

    vi.useRealTimers();
  });

  it("invalidates Redis adapter on pub client error and reconnects", async () => {
    vi.useFakeTimers();
    const {
      io,
      pubClient,
      module: { initSocketIoRedisAdapter, isSocketIoRedisAdapterActive },
      metrics,
    } = await setupAdapterModule();

    await initSocketIoRedisAdapter(io);
    expect(isSocketIoRedisAdapterActive()).toBe(true);

    const errorHandler = pubClient.on.mock.calls.find(([event]) => event === "error")?.[1] as
      | ((error: Error) => void)
      | undefined;
    expect(errorHandler).toBeTypeOf("function");

    errorHandler?.(new Error("pub/sub lost"));

    expect(isSocketIoRedisAdapterActive()).toBe(false);
    expect(metrics.getSocketIoRedisAdapterMetricsSnapshot()).toMatchObject({
      runtimeErrorEventsTotal: 1,
      redisAdapterActive: 0,
    });
    expect(io.adapter).toHaveBeenCalledWith(expect.any(Function));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runOnlyPendingTimersAsync();

    expect(isSocketIoRedisAdapterActive()).toBe(true);
    expect(metrics.getSocketIoRedisAdapterMetricsSnapshot().connectionEventsTotal).toBe(2);

    vi.useRealTimers();
  });

  it("fail-hard in production when initial connect fails", async () => {
    const {
      io,
      pubClient,
      module: { initSocketIoRedisAdapter },
      metrics,
    } = await setupAdapterModule({ nodeEnv: "production" });
    pubClient.connect.mockRejectedValue(new Error("redis unavailable"));

    await expect(initSocketIoRedisAdapter(io)).rejects.toThrow("redis unavailable");
    expect(metrics.getSocketIoRedisAdapterMetricsSnapshot().fallbackEventsTotal).toBe(0);
  });

  it("fail-hard in non-production when SOCKET_IO_REDIS_ADAPTER_REQUIRED is true", async () => {
    const {
      io,
      pubClient,
      module: { initSocketIoRedisAdapter },
      metrics,
    } = await setupAdapterModule({ nodeEnv: "development", redisAdapterRequired: true });
    pubClient.connect.mockRejectedValue(new Error("redis unavailable"));

    await expect(initSocketIoRedisAdapter(io)).rejects.toThrow("redis unavailable");
    expect(metrics.getSocketIoRedisAdapterMetricsSnapshot().fallbackEventsTotal).toBe(0);
  });

  it("falls back in non-production when SOCKET_IO_REDIS_ADAPTER_REQUIRED is false", async () => {
    const {
      io,
      pubClient,
      module: { initSocketIoRedisAdapter, isSocketIoRedisAdapterActive },
      metrics,
    } = await setupAdapterModule({ nodeEnv: "development", redisAdapterRequired: false });
    pubClient.connect.mockRejectedValueOnce(new Error("redis unavailable"));

    await initSocketIoRedisAdapter(io);

    expect(isSocketIoRedisAdapterActive()).toBe(false);
    expect(metrics.getSocketIoRedisAdapterMetricsSnapshot().fallbackEventsTotal).toBe(1);
  });

  it("reattachSocketIoRedisAdapter reuses the registered server", async () => {
    const {
      io,
      createClientMock,
      module: { closeSocketIoRedisAdapter, initSocketIoRedisAdapter, reattachSocketIoRedisAdapter },
    } = await setupAdapterModule();

    await initSocketIoRedisAdapter(io);
    await closeSocketIoRedisAdapter({ preserveRegistration: true });
    await reattachSocketIoRedisAdapter();

    expect(createClientMock).toHaveBeenCalledTimes(2);
  });
});
