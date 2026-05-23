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
  "SOCKET_AUTH_REQUIRED",
  "SOCKET_CONNECTION_READY_COMPAT_MODE",
  "SOCKET_AGENTS_COMMAND_COMPAT_MODE",
  "SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE",
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
  process.env.SOCKET_AUTH_REQUIRED = "true";
  delete process.env.SOCKET_CONNECTION_READY_COMPAT_MODE;
  delete process.env.SOCKET_AGENTS_COMMAND_COMPAT_MODE;
  delete process.env.SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE;
};

describe("production socket compat mode bootstrap assertions", () => {
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

  it("loads production env when compat modes use payload_frame defaults", async () => {
    const env = await reloadEnv();
    expect(env.nodeEnv).toBe("production");
    expect(env.socketConnectionReadyCompatMode).toBe("payload_frame");
    expect(env.socketAgentsCommandCompatMode).toBe("payload_frame");
    expect(env.socketAgentsStreamPullCompatMode).toBe("payload_frame");
  });

  it.each([
    ["SOCKET_CONNECTION_READY_COMPAT_MODE", "socketConnectionReadyCompatMode"],
    ["SOCKET_AGENTS_COMMAND_COMPAT_MODE", "socketAgentsCommandCompatMode"],
    ["SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE", "socketAgentsStreamPullCompatMode"],
  ] as const)("rejects %s=raw_json in production", async (envKey, _exportedKey) => {
    process.env[envKey] = "raw_json";
    await expect(reloadEnv()).rejects.toThrow(
      `Invalid production config: ${envKey} must not be raw_json in production.`,
    );
  });

  it("allows raw_json compat modes outside production", async () => {
    process.env.NODE_ENV = "development";
    process.env.SOCKET_CONNECTION_READY_COMPAT_MODE = "raw_json";
    process.env.SOCKET_AGENTS_COMMAND_COMPAT_MODE = "raw_json";
    process.env.SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE = "raw_json";

    const env = await reloadEnv();
    expect(env.nodeEnv).toBe("development");
    expect(env.socketConnectionReadyCompatMode).toBe("raw_json");
    expect(env.socketAgentsCommandCompatMode).toBe("raw_json");
    expect(env.socketAgentsStreamPullCompatMode).toBe("raw_json");
  });
});
