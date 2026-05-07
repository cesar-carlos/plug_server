import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { env as EnvSnapshot } from "../../../../src/shared/config/env";

const previous = process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED;

const reloadEnv = async (): Promise<typeof EnvSnapshot> => {
  vi.resetModules();
  const module = await import("../../../../src/shared/config/env");
  return module.env;
};

describe("env.socketClientAgentProfilePushEnabled", () => {
  beforeEach(() => {
    delete process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED;
    } else {
      process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED = previous;
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
});
