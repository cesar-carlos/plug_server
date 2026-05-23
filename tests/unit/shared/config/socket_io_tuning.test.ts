import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({
  default: {
    config: vi.fn(() => ({ parsed: {} })),
  },
}));

import type { env as EnvSnapshot } from "../../../../src/shared/config/env";

const envKeys = [
  "SOCKET_IO_PING_INTERVAL_MS",
  "SOCKET_IO_PING_TIMEOUT_MS",
  "SOCKET_IO_UPGRADE_TIMEOUT_MS",
  "SOCKET_IO_REDIS_ADAPTER_KEY",
  "SOCKET_IO_REDIS_ADAPTER_REQUESTS_TIMEOUT_MS",
  "SOCKET_IO_REDIS_ADAPTER_PUBLISH_ON_SPECIFIC_RESPONSE_CHANNEL",
  "SOCKET_IO_REDIS_ADAPTER_CONNECT_TIMEOUT_MS",
  "SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS",
  "SOCKET_IO_REDIS_ADAPTER_RECONNECT_MAX_MS",
] as const;

type EnvKey = (typeof envKeys)[number];

const previousValues: Partial<Record<EnvKey, string | undefined>> = {};

const reloadEnv = async (): Promise<typeof EnvSnapshot> => {
  vi.resetModules();
  const module = await import("../../../../src/shared/config/env");
  return module.env;
};

describe("env Socket.IO / Redis adapter tuning", () => {
  beforeEach(() => {
    for (const key of envKeys) {
      previousValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const previous = previousValues[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    vi.resetModules();
  });

  it("defaults optional Engine.IO heartbeat/upgrade overrides to undefined", async () => {
    const env = await reloadEnv();
    expect(env.socketIoPingIntervalMs).toBeUndefined();
    expect(env.socketIoPingTimeoutMs).toBeUndefined();
    expect(env.socketIoUpgradeTimeoutMs).toBeUndefined();
  });

  it("parses optional Engine.IO heartbeat and upgrade overrides", async () => {
    process.env.SOCKET_IO_PING_INTERVAL_MS = "30000";
    process.env.SOCKET_IO_PING_TIMEOUT_MS = "25000";
    process.env.SOCKET_IO_UPGRADE_TIMEOUT_MS = "15000";
    const env = await reloadEnv();
    expect(env.socketIoPingIntervalMs).toBe(30_000);
    expect(env.socketIoPingTimeoutMs).toBe(25_000);
    expect(env.socketIoUpgradeTimeoutMs).toBe(15_000);
  });

  it("defaults Redis adapter tuning to library/hub historical values", async () => {
    const env = await reloadEnv();
    expect(env.socketIoRedisAdapterKey).toBe("socket.io");
    expect(env.socketIoRedisAdapterRequestsTimeoutMs).toBe(5_000);
    expect(env.socketIoRedisAdapterPublishOnSpecificResponseChannel).toBe(false);
    expect(env.socketIoRedisAdapterConnectTimeoutMs).toBe(5_000);
    expect(env.socketIoRedisAdapterReconnectBaseMs).toBe(1_000);
    expect(env.socketIoRedisAdapterReconnectMaxMs).toBe(30_000);
  });

  it("parses Redis adapter tuning overrides", async () => {
    process.env.SOCKET_IO_REDIS_ADAPTER_KEY = "plug-hub";
    process.env.SOCKET_IO_REDIS_ADAPTER_REQUESTS_TIMEOUT_MS = "8000";
    process.env.SOCKET_IO_REDIS_ADAPTER_PUBLISH_ON_SPECIFIC_RESPONSE_CHANNEL = "true";
    process.env.SOCKET_IO_REDIS_ADAPTER_CONNECT_TIMEOUT_MS = "7000";
    process.env.SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS = "2000";
    process.env.SOCKET_IO_REDIS_ADAPTER_RECONNECT_MAX_MS = "45000";
    const env = await reloadEnv();
    expect(env.socketIoRedisAdapterKey).toBe("plug-hub");
    expect(env.socketIoRedisAdapterRequestsTimeoutMs).toBe(8_000);
    expect(env.socketIoRedisAdapterPublishOnSpecificResponseChannel).toBe(true);
    expect(env.socketIoRedisAdapterConnectTimeoutMs).toBe(7_000);
    expect(env.socketIoRedisAdapterReconnectBaseMs).toBe(2_000);
    expect(env.socketIoRedisAdapterReconnectMaxMs).toBe(45_000);
  });

  it("rejects invalid Redis adapter boolean enum", async () => {
    process.env.SOCKET_IO_REDIS_ADAPTER_PUBLISH_ON_SPECIFIC_RESPONSE_CHANNEL = "yes";
    await expect(reloadEnv()).rejects.toThrow();
  });

  it("rejects empty Redis adapter key", async () => {
    process.env.SOCKET_IO_REDIS_ADAPTER_KEY = "   ";
    await expect(reloadEnv()).rejects.toThrow();
  });
});
