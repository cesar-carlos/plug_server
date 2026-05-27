import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as RedisAuthPingMetricsModuleNs from "../../../../src/application/services/redis_auth_ping_metrics.service";
import type * as InstrumentedRedisClientModuleNs from "../../../../src/infrastructure/redis/instrumented_redis_client";

const setupFactory = async (
  envOverrides: { readonly nodeEnv?: "development" | "test" | "production" } = {},
): Promise<{
  readonly module: typeof InstrumentedRedisClientModuleNs;
  readonly authMetrics: typeof RedisAuthPingMetricsModuleNs;
  readonly client: {
    readonly on: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly quit: ReturnType<typeof vi.fn>;
    readonly ping: ReturnType<typeof vi.fn>;
  };
  readonly createClientMock: ReturnType<typeof vi.fn>;
}> => {
  vi.resetModules();
  const client = {
    on: vi.fn(() => client),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue("PONG"),
  };
  const createClientMock = vi.fn(() => client);

  vi.doMock("../../../../src/shared/config/env", () => ({
    env: {
      nodeEnv: envOverrides.nodeEnv ?? "test",
      redisDefaultConnectTimeoutMs: 5_000,
      redisTenantId: "",
      redisDefaultReconnectBaseMs: 200,
      redisDefaultReconnectMaxMs: 5_000,
    },
  }));
  vi.doMock("redis", () => ({ createClient: createClientMock }));

  const module = await import("../../../../src/infrastructure/redis/instrumented_redis_client");
  const authMetrics =
    await import("../../../../src/application/services/redis_auth_ping_metrics.service");
  authMetrics.resetRedisAuthPingMetricsForTests();
  return { module, authMetrics, client, createClientMock };
};

const buildCallbacks = (): {
  readonly callbacks: {
    onConnected: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    onEnd: ReturnType<typeof vi.fn>;
    onFallback: ReturnType<typeof vi.fn>;
  };
} => ({
  callbacks: {
    onConnected: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
    onFallback: vi.fn(),
  },
});

describe("instrumented_redis_client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../../../../src/shared/config/env");
    vi.doUnmock("redis");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns the connected client and pings to validate AUTH (records ok counter)", async () => {
    const { module, authMetrics, client } = await setupFactory();
    const { callbacks } = buildCallbacks();

    const result = await module.createInstrumentedRedisClient({
      url: "redis://localhost:6379",
      logName: "test_module",
      callbacks,
    });

    expect(result).toBe(client);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.ping).toHaveBeenCalledOnce();
    expect(callbacks.onConnected).toHaveBeenCalledOnce();
    expect(callbacks.onFallback).not.toHaveBeenCalled();
    expect(authMetrics.getRedisAuthPingMetricsSnapshot()).toContainEqual({
      module: "test_module",
      outcome: "ok",
      count: 1,
    });
  });

  it("returns undefined and invokes onFallback when connect fails", async () => {
    const { module, client } = await setupFactory();
    const { callbacks } = buildCallbacks();
    client.connect.mockRejectedValueOnce(new Error("redis unavailable"));

    const result = await module.createInstrumentedRedisClient({
      url: "redis://localhost:6379",
      logName: "test_module",
      callbacks,
    });

    expect(result).toBeUndefined();
    expect(callbacks.onFallback).toHaveBeenCalledOnce();
    expect(callbacks.onConnected).not.toHaveBeenCalled();
  });

  it("aborts boot when ping reveals WRONGPASS in production", async () => {
    const { module, client } = await setupFactory({ nodeEnv: "production" });
    const { callbacks } = buildCallbacks();
    client.ping.mockRejectedValueOnce(
      new Error("WRONGPASS invalid username-password pair or user is disabled."),
    );

    await expect(
      module.createInstrumentedRedisClient({
        url: "redis://localhost:6379",
        logName: "test_module",
        callbacks,
      }),
    ).rejects.toThrow(/Redis authentication failed/);
    expect(client.quit).toHaveBeenCalled();
  });

  it("aborts boot when ping reveals NOAUTH in production", async () => {
    const { module, client } = await setupFactory({ nodeEnv: "production" });
    const { callbacks } = buildCallbacks();
    client.ping.mockRejectedValueOnce(new Error("NOAUTH Authentication required."));

    await expect(
      module.createInstrumentedRedisClient({
        url: "redis://localhost:6379",
        logName: "test_module",
        callbacks,
      }),
    ).rejects.toThrow(/Redis authentication failed/);
  });

  it("logs and continues when ping fails outside production (records auth_error counter)", async () => {
    const { module, authMetrics, client } = await setupFactory({ nodeEnv: "test" });
    const { callbacks } = buildCallbacks();
    client.ping.mockRejectedValueOnce(new Error("WRONGPASS"));

    const result = await module.createInstrumentedRedisClient({
      url: "redis://localhost:6379",
      logName: "test_module",
      callbacks,
    });

    expect(result).toBe(client);
    expect(callbacks.onConnected).toHaveBeenCalledOnce();
    expect(authMetrics.getRedisAuthPingMetricsSnapshot()).toContainEqual({
      module: "test_module",
      outcome: "auth_error",
      count: 1,
    });
  });

  it("logs and continues when ping fails for a non-auth reason in production (records other_error)", async () => {
    const { module, authMetrics, client } = await setupFactory({ nodeEnv: "production" });
    const { callbacks } = buildCallbacks();
    client.ping.mockRejectedValueOnce(new Error("connection timeout"));

    const result = await module.createInstrumentedRedisClient({
      url: "redis://localhost:6379",
      logName: "test_module",
      callbacks,
    });

    // Non-auth failures do not abort boot — the regular error/fallback path
    // handles them via the listener wiring.
    expect(result).toBe(client);
    expect(callbacks.onConnected).toHaveBeenCalledOnce();
    expect(authMetrics.getRedisAuthPingMetricsSnapshot()).toContainEqual({
      module: "test_module",
      outcome: "other_error",
      count: 1,
    });
  });

  it("returns undefined when url is empty", async () => {
    const { module, createClientMock } = await setupFactory();
    const { callbacks } = buildCallbacks();

    const result = await module.createInstrumentedRedisClient({
      url: "",
      logName: "test_module",
      callbacks,
    });

    expect(result).toBeUndefined();
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
