import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientSocketEventPublishIdempotencyResponse } from "../../../../src/application/services/client_socket_event_idempotency_store";
import type * as IdempotencyRedisModuleNs from "../../../../src/infrastructure/redis/client_socket_event_publish_idempotency_redis";
import type * as DistributedIdempotencyRegistryNs from "../../../../src/application/services/client_socket_event_publish_distributed_idempotency";

type IdempotencyRedisModule = typeof IdempotencyRedisModuleNs;
type DistributedIdempotencyRegistry = typeof DistributedIdempotencyRegistryNs;

interface MockClient {
  readonly on: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly quit: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
  readonly del: ReturnType<typeof vi.fn>;
  readonly pTTL: ReturnType<typeof vi.fn>;
  readonly eval: ReturnType<typeof vi.fn>;
  readonly evalSha: ReturnType<typeof vi.fn>;
  readonly scriptLoad: ReturnType<typeof vi.fn>;
}

const setup = async (): Promise<{
  readonly client: MockClient;
  readonly module: IdempotencyRedisModule;
  readonly registry: DistributedIdempotencyRegistry;
}> => {
  vi.resetModules();

  const client: MockClient = {
    on: vi.fn(() => client),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    pTTL: vi.fn().mockResolvedValue(60_000),
    eval: vi.fn(),
    evalSha: vi.fn(),
    scriptLoad: vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve("sha-release-lock"))
      .mockImplementationOnce(() => Promise.resolve("sha-extend-lock")),
  };
  vi.doMock("../../../../src/shared/config/env", () => ({
    env: {
      restSocketEventIdempotencyRedisUrl: "redis://localhost:6379",
      restSocketEventIdempotencyTtlMs: 60_000,
      restSocketEventIdempotencyRedisReadUrl: "",
      redisDefaultConnectTimeoutMs: 5_000,
      redisTenantId: "",
      redisDefaultReconnectBaseMs: 200,
      redisDefaultReconnectMaxMs: 5_000,
    },
  }));
  vi.doMock("redis", () => ({ createClient: () => client }));

  const module =
    await import("../../../../src/infrastructure/redis/client_socket_event_publish_idempotency_redis");
  const registry =
    await import("../../../../src/application/services/client_socket_event_publish_distributed_idempotency");
  return { client, module, registry };
};

describe("client_socket_event_publish_idempotency_redis", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../../../../src/shared/config/env");
    vi.doUnmock("redis");
  });

  it("acquireLock returns the token on SET NX OK and undefined on contention", async () => {
    const { client, module, registry } = await setup();
    client.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await module.initClientSocketEventPublishIdempotencyRedis();
    const store = registry.getClientSocketEventPublishDistributedIdempotencyStore();
    expect(store).toBeDefined();

    const token = await store!.acquireLock("client-1", "idem-1", 5_000);
    expect(typeof token).toBe("string");
    expect(token!.length).toBeGreaterThan(0);
    expect(client.set).toHaveBeenCalledWith(
      expect.stringContaining("plug_socket_event_idem_lock:{plug}:"),
      token,
      { NX: true, PX: 5_000 },
    );

    const second = await store!.acquireLock("client-1", "idem-1", 5_000);
    expect(second).toBeUndefined();

    await module.closeClientSocketEventPublishIdempotencyRedis();
  });

  it("extendLock returns true when caller still owns the lock (cached EVALSHA returns 1)", async () => {
    const { client, module, registry } = await setup();
    client.evalSha.mockResolvedValue(1);

    await module.initClientSocketEventPublishIdempotencyRedis();
    const store = registry.getClientSocketEventPublishDistributedIdempotencyStore();
    expect(store).toBeDefined();

    const extended = await store!.extendLock("client-1", "idem-1", "tok-abc", 5_000);
    expect(extended).toBe(true);
    expect(client.evalSha).toHaveBeenCalledWith(
      "sha-extend-lock",
      expect.objectContaining({
        keys: [expect.stringContaining("plug_socket_event_idem_lock:{plug}:")],
        arguments: ["tok-abc", "5000"],
      }),
    );
    expect(client.eval).not.toHaveBeenCalled();

    await module.closeClientSocketEventPublishIdempotencyRedis();
  });

  it("extendLock returns false when token does not match (EVALSHA returns 0)", async () => {
    const { client, module, registry } = await setup();
    client.evalSha.mockResolvedValue(0);

    await module.initClientSocketEventPublishIdempotencyRedis();
    const store = registry.getClientSocketEventPublishDistributedIdempotencyStore();

    const extended = await store!.extendLock("client-1", "idem-1", "stale-token", 5_000);
    expect(extended).toBe(false);

    await module.closeClientSocketEventPublishIdempotencyRedis();
  });

  it("extendLock returns false when ttlMs <= 0 (no Redis call)", async () => {
    const { client, module, registry } = await setup();

    await module.initClientSocketEventPublishIdempotencyRedis();
    const store = registry.getClientSocketEventPublishDistributedIdempotencyStore();

    const extended = await store!.extendLock("client-1", "idem-1", "tok", 0);
    expect(extended).toBe(false);
    expect(client.evalSha).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();

    await module.closeClientSocketEventPublishIdempotencyRedis();
  });

  it("extendLock swallows Redis errors and returns false", async () => {
    const { client, module, registry } = await setup();
    client.evalSha.mockRejectedValue(new Error("redis flaky"));

    await module.initClientSocketEventPublishIdempotencyRedis();
    const store = registry.getClientSocketEventPublishDistributedIdempotencyStore();

    const extended = await store!.extendLock("client-1", "idem-1", "tok", 5_000);
    expect(extended).toBe(false);

    await module.closeClientSocketEventPublishIdempotencyRedis();
  });

  it("setEntry persists JSON-serialised entry with PX TTL", async () => {
    const { client, module, registry } = await setup();
    client.set.mockResolvedValue("OK");

    await module.initClientSocketEventPublishIdempotencyRedis();
    const store = registry.getClientSocketEventPublishDistributedIdempotencyStore();
    const response: ClientSocketEventPublishIdempotencyResponse = {
      success: true,
      eventId: "e1",
      eventName: "client:custom.test",
      recipients: 3,
    };

    await store!.setEntry("client-1", "idem-1", { fingerprint: "fp", response });

    expect(client.set).toHaveBeenCalledWith(
      expect.stringContaining("plug_socket_event_idem:{plug}:"),
      JSON.stringify({ fingerprint: "fp", response }),
      { PX: 60_000 },
    );

    await module.closeClientSocketEventPublishIdempotencyRedis();
  });
});
