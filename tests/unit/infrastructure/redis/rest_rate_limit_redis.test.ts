import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as RestRateLimitRedisModule from "../../../../src/infrastructure/redis/rest_rate_limit_redis";

interface CapturedRedisStoreOptions {
  readonly prefix: string;
  readonly sendCommand: (...args: string[]) => Promise<unknown>;
}

type RedisStoreMockFactory = (options: CapturedRedisStoreOptions) => unknown;

const setupRedisModule = async (): Promise<{
  readonly client: {
    readonly on: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly quit: ReturnType<typeof vi.fn>;
    readonly sendCommand: ReturnType<typeof vi.fn>;
  };
  readonly clientSendCommand: ReturnType<typeof vi.fn>;
  readonly createClientMock: ReturnType<typeof vi.fn>;
  readonly envMock: {
    restRateLimitRedisUrl: string;
  };
  readonly capturedStores: CapturedRedisStoreOptions[];
  readonly module: typeof RestRateLimitRedisModule;
}> => setupRedisModuleWithStore();

const setupRedisModuleWithStore = async (
  storeFactory?: RedisStoreMockFactory,
): Promise<{
  readonly client: {
    readonly on: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly quit: ReturnType<typeof vi.fn>;
    readonly sendCommand: ReturnType<typeof vi.fn>;
  };
  readonly clientSendCommand: ReturnType<typeof vi.fn>;
  readonly createClientMock: ReturnType<typeof vi.fn>;
  readonly envMock: {
    restRateLimitRedisUrl: string;
  };
  readonly capturedStores: CapturedRedisStoreOptions[];
  readonly module: typeof RestRateLimitRedisModule;
}> => {
  vi.resetModules();

  const listeners = new Map<string, (error?: Error) => void>();
  const clientSendCommand = vi.fn();
  const client = {
    on: vi.fn((event: string, listener: (error?: Error) => void) => {
      listeners.set(event, listener);
      return client;
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    sendCommand: clientSendCommand,
  };
  const capturedStores: CapturedRedisStoreOptions[] = [];

  const envMock = {
    restRateLimitRedisUrl: "redis://localhost:6379",
  };
  const createClientMock = vi.fn(() => client);
  vi.doMock("../../../../src/shared/config/env", () => ({
    env: envMock,
  }));
  vi.doMock("redis", () => ({
    createClient: createClientMock,
  }));
  vi.doMock("rate-limit-redis", () => ({
    RedisStore: vi.fn((options: CapturedRedisStoreOptions) => {
      capturedStores.push(options);
      return storeFactory ? storeFactory(options) : { options };
    }),
  }));

  const module = await import("../../../../src/infrastructure/redis/rest_rate_limit_redis");
  return { client, clientSendCommand, createClientMock, envMock, capturedStores, module };
};

describe("rest_rate_limit_redis", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../../../../src/shared/config/env");
    vi.doUnmock("redis");
    vi.doUnmock("rate-limit-redis");
  });

  it("opens a short circuit after repeated Redis command failures", async () => {
    const {
      clientSendCommand,
      capturedStores,
      module: {
        closeRestHttpRateLimitRedis,
        createRestHttpRateLimitStore,
        initRestHttpRateLimitRedis,
      },
    } = await setupRedisModule();

    await initRestHttpRateLimitRedis();
    createRestHttpRateLimitStore("global");
    const sendCommand = capturedStores[0]?.sendCommand;
    expect(sendCommand).toBeDefined();
    clientSendCommand.mockRejectedValue(new Error("redis down"));

    await expect(sendCommand?.("INCR", "key")).rejects.toThrow(
      "Redis rate-limit store unavailable",
    );
    await expect(sendCommand?.("INCR", "key")).rejects.toThrow(
      "Redis rate-limit store unavailable",
    );
    await expect(sendCommand?.("INCR", "key")).rejects.toThrow(
      "Redis rate-limit store unavailable",
    );
    await expect(sendCommand?.("INCR", "key")).rejects.toThrow(
      "Redis rate-limit store circuit is open",
    );
    expect(clientSendCommand).toHaveBeenCalledTimes(3);

    await closeRestHttpRateLimitRedis();
  });

  it("handles RedisStore script warmup rejections outside the request path", async () => {
    const warmupError = new Error("script load failed");
    const {
      module: {
        closeRestHttpRateLimitRedis,
        createRestHttpRateLimitStore,
        initRestHttpRateLimitRedis,
      },
    } = await setupRedisModuleWithStore((options) => ({
      options,
      incrementScriptSha: Promise.reject(warmupError),
      getScriptSha: Promise.reject(warmupError),
    }));

    await initRestHttpRateLimitRedis();
    expect(createRestHttpRateLimitStore("global")).toBeDefined();
    await Promise.resolve();

    await closeRestHttpRateLimitRedis();
  });

  it("falls back to the memory store when RedisStore creation throws", async () => {
    let storeCreateAttempts = 0;
    const {
      client,
      module: {
        closeRestHttpRateLimitRedis,
        createRestHttpRateLimitStore,
        initRestHttpRateLimitRedis,
      },
    } = await setupRedisModuleWithStore(() => {
      storeCreateAttempts += 1;
      throw new Error("store init failed");
    });

    await initRestHttpRateLimitRedis();
    expect(createRestHttpRateLimitStore("global")).toBeUndefined();
    expect(createRestHttpRateLimitStore("credential_auth")).toBeUndefined();
    expect(storeCreateAttempts).toBe(1);
    expect(client.quit).toHaveBeenCalledTimes(1);

    await closeRestHttpRateLimitRedis();
  });

  it("does not reconnect when initialized twice with the same Redis URL", async () => {
    const {
      createClientMock,
      module: { closeRestHttpRateLimitRedis, initRestHttpRateLimitRedis },
    } = await setupRedisModule();

    await initRestHttpRateLimitRedis();
    await initRestHttpRateLimitRedis();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    await closeRestHttpRateLimitRedis();
  });

  it("closes the previous Redis client when the configured URL changes", async () => {
    const {
      client,
      createClientMock,
      envMock,
      module: { closeRestHttpRateLimitRedis, initRestHttpRateLimitRedis },
    } = await setupRedisModule();

    await initRestHttpRateLimitRedis();
    envMock.restRateLimitRedisUrl = "redis://localhost:6380";
    await initRestHttpRateLimitRedis();

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(client.quit).toHaveBeenCalledTimes(1);
    await closeRestHttpRateLimitRedis();
  });

  it("rejects commands from stores bound to an obsolete Redis client generation", async () => {
    const {
      capturedStores,
      envMock,
      module: {
        closeRestHttpRateLimitRedis,
        createRestHttpRateLimitStore,
        initRestHttpRateLimitRedis,
      },
    } = await setupRedisModule();

    await initRestHttpRateLimitRedis();
    createRestHttpRateLimitStore("global");
    const oldSendCommand = capturedStores[0]?.sendCommand;
    expect(oldSendCommand).toBeDefined();

    envMock.restRateLimitRedisUrl = "redis://localhost:6380";
    await initRestHttpRateLimitRedis();

    await expect(oldSendCommand?.("INCR", "key")).rejects.toThrow(
      "Redis rate-limit store unavailable",
    );
    await closeRestHttpRateLimitRedis();
  });
});
