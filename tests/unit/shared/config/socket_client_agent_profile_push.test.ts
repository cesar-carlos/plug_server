import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { env as EnvSnapshot } from "../../../../src/shared/config/env";

const previousEnabled = process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED;
const previousTtl = process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS;
const previousMaxSize = process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE;

const reloadEnv = async (): Promise<typeof EnvSnapshot> => {
  vi.resetModules();
  const module = await import("../../../../src/shared/config/env");
  return module.env;
};

describe("env.socketClientAgentProfilePushEnabled", () => {
  beforeEach(() => {
    delete process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED;
    delete process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS;
    delete process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE;
  });

  afterEach(() => {
    if (previousEnabled === undefined) {
      delete process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED;
    } else {
      process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED = previousEnabled;
    }
    if (previousTtl === undefined) {
      delete process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS;
    } else {
      process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS = previousTtl;
    }
    if (previousMaxSize === undefined) {
      delete process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE;
    } else {
      process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE = previousMaxSize;
    }
    vi.resetModules();
  });

  it("defaults to true when SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED is unset", async () => {
    const env = await reloadEnv();
    expect(env.socketClientAgentProfilePushEnabled).toBe(true);
  });

  it('parses "true" as enabled', async () => {
    process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED = "true";
    const env = await reloadEnv();
    expect(env.socketClientAgentProfilePushEnabled).toBe(true);
  });

  it('parses "false" as disabled (operational kill-switch)', async () => {
    process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED = "false";
    const env = await reloadEnv();
    expect(env.socketClientAgentProfilePushEnabled).toBe(false);
  });

  it("rejects values outside the supported boolean enum", async () => {
    process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED = "yes";
    await expect(reloadEnv()).rejects.toThrow();
  });

  it("defaults the profile recipient cache bounds", async () => {
    const env = await reloadEnv();
    expect(env.socketClientAgentProfileRecipientCacheTtlMs).toBe(1000);
    expect(env.socketClientAgentProfileRecipientCacheMaxSize).toBe(5000);
  });

  it("parses profile recipient cache bounds", async () => {
    process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS = "2500";
    process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE = "42";
    const env = await reloadEnv();
    expect(env.socketClientAgentProfileRecipientCacheTtlMs).toBe(2500);
    expect(env.socketClientAgentProfileRecipientCacheMaxSize).toBe(42);
  });
});
