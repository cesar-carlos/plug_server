import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { env as EnvSnapshot } from "../../../../src/shared/config/env";

const previousEnabled = process.env.SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED;
const previousTtl = process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS;
const previousMaxSize = process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE;
const previousReconcileInterval =
  process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS;
const previousReconcileConcurrency =
  process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY;
const previousReconcileMaxClientsPerTick =
  process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK;
const previousReconcileStartJitterMs =
  process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS;

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
    delete process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS;
    delete process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY;
    delete process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK;
    delete process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS;
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
    if (previousReconcileInterval === undefined) {
      delete process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS;
    } else {
      process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS =
        previousReconcileInterval;
    }
    if (previousReconcileConcurrency === undefined) {
      delete process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY;
    } else {
      process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY =
        previousReconcileConcurrency;
    }
    if (previousReconcileMaxClientsPerTick === undefined) {
      delete process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK;
    } else {
      process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK =
        previousReconcileMaxClientsPerTick;
    }
    if (previousReconcileStartJitterMs === undefined) {
      delete process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS;
    } else {
      process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS =
        previousReconcileStartJitterMs;
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
    expect(env.socketConsumerClientAgentRoomReconcileIntervalMs).toBe(30000);
    expect(env.socketConsumerClientAgentRoomReconcileConcurrency).toBe(8);
    expect(env.socketConsumerClientAgentRoomReconcileMaxClientsPerTick).toBe(200);
    expect(env.socketConsumerClientAgentRoomReconcileStartJitterMs).toBe(1000);
  });

  it("parses profile recipient cache bounds", async () => {
    process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS = "2500";
    process.env.SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE = "42";
    const env = await reloadEnv();
    expect(env.socketClientAgentProfileRecipientCacheTtlMs).toBe(2500);
    expect(env.socketClientAgentProfileRecipientCacheMaxSize).toBe(42);
  });

  it("parses the client-agent room reconciliation interval", async () => {
    process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS = "7500";
    process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY = "4";
    process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK = "25";
    process.env.SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS = "250";
    const env = await reloadEnv();
    expect(env.socketConsumerClientAgentRoomReconcileIntervalMs).toBe(7500);
    expect(env.socketConsumerClientAgentRoomReconcileConcurrency).toBe(4);
    expect(env.socketConsumerClientAgentRoomReconcileMaxClientsPerTick).toBe(25);
    expect(env.socketConsumerClientAgentRoomReconcileStartJitterMs).toBe(250);
  });
});
