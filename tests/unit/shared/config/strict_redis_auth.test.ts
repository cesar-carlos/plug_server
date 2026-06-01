import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({
  default: {
    config: vi.fn(() => ({ parsed: {} })),
  },
}));

import type { env as EnvSnapshot } from "../../../../src/shared/config/env";

const PRODUCTION_ENV_KEYS = [
  "NODE_ENV",
  "CORS_ORIGIN",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "SMTP_USER",
  "SMTP_PASS",
  "SOCKET_AUTH_REQUIRED",
  "STRICT_REDIS_AUTH",
  "SOCKET_IO_REDIS_ADAPTER_URL",
  "REST_RATE_LIMIT_REDIS_URL",
  "SOCKET_RATE_LIMIT_REDIS_URL",
  "REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL",
] as const;

type ProductionEnvKey = (typeof PRODUCTION_ENV_KEYS)[number];

const previousEnv: Partial<Record<ProductionEnvKey, string | undefined>> = {};

const reloadEnv = async (): Promise<typeof EnvSnapshot> => {
  vi.resetModules();
  const module = await import("../../../../src/shared/config/env");
  return module.env;
};

const setValidProductionEnv = (): void => {
  process.env.NODE_ENV = "production";
  process.env.CORS_ORIGIN = "https://example.com";
  process.env.JWT_ACCESS_SECRET = "production-access-secret-32chars";
  process.env.JWT_REFRESH_SECRET = "production-refresh-secret-32chars";
  process.env.SMTP_USER = "ci@example.com";
  process.env.SMTP_PASS = "ci-smtp-password";
  process.env.SOCKET_AUTH_REQUIRED = "true";
  delete process.env.STRICT_REDIS_AUTH;
  delete process.env.SOCKET_IO_REDIS_ADAPTER_URL;
  delete process.env.REST_RATE_LIMIT_REDIS_URL;
  delete process.env.SOCKET_RATE_LIMIT_REDIS_URL;
  delete process.env.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL;
};

describe("STRICT_REDIS_AUTH production validation", () => {
  beforeEach(() => {
    for (const key of PRODUCTION_ENV_KEYS) {
      previousEnv[key] = process.env[key];
    }
    setValidProductionEnv();
  });

  afterEach(() => {
    for (const key of PRODUCTION_ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  });

  it("loads when STRICT_REDIS_AUTH is false (default) even with plain redis://", async () => {
    process.env.SOCKET_IO_REDIS_ADAPTER_URL = "redis://127.0.0.1:6379";
    const env = await reloadEnv();
    expect(env.strictRedisAuth).toBe(false);
    expect(env.socketIoRedisAdapterUrl).toBe("redis://127.0.0.1:6379");
  });

  it("loads when STRICT_REDIS_AUTH=true and all URLs are empty", async () => {
    process.env.STRICT_REDIS_AUTH = "true";
    const env = await reloadEnv();
    expect(env.strictRedisAuth).toBe(true);
  });

  it("loads when STRICT_REDIS_AUTH=true and URL uses rediss:// (TLS)", async () => {
    process.env.STRICT_REDIS_AUTH = "true";
    process.env.SOCKET_IO_REDIS_ADAPTER_URL = "rediss://example.com:6380";
    const env = await reloadEnv();
    expect(env.socketIoRedisAdapterUrl).toBe("rediss://example.com:6380");
  });

  it("loads when STRICT_REDIS_AUTH=true and redis:// URL has password", async () => {
    process.env.STRICT_REDIS_AUTH = "true";
    process.env.REST_RATE_LIMIT_REDIS_URL = "redis://default:secret@redis.local:6379";
    const env = await reloadEnv();
    expect(env.restRateLimitRedisUrl).toBe("redis://default:secret@redis.local:6379");
  });

  it("rejects plain redis:// without password when STRICT_REDIS_AUTH=true", async () => {
    process.env.STRICT_REDIS_AUTH = "true";
    process.env.SOCKET_IO_REDIS_ADAPTER_URL = "redis://redis.local:6379";
    await expect(reloadEnv()).rejects.toThrow(/SOCKET_IO_REDIS_ADAPTER_URL must use rediss:\/\//);
  });

  it("rejects malformed Redis URL when STRICT_REDIS_AUTH=true", async () => {
    process.env.STRICT_REDIS_AUTH = "true";
    process.env.REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL = "not-a-url";
    await expect(reloadEnv()).rejects.toThrow(/is not a valid URL/);
  });

  it("does not enforce STRICT_REDIS_AUTH outside production", async () => {
    process.env.NODE_ENV = "development";
    process.env.STRICT_REDIS_AUTH = "true";
    process.env.SOCKET_IO_REDIS_ADAPTER_URL = "redis://127.0.0.1:6379";
    const env = await reloadEnv();
    expect(env.strictRedisAuth).toBe(true);
    expect(env.socketIoRedisAdapterUrl).toBe("redis://127.0.0.1:6379");
  });
});
