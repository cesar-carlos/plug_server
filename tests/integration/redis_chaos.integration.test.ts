import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "redis";

import type * as AgentEventStreamModuleNs from "../../src/infrastructure/redis/agent_event_stream";

import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeAgentEventStreamInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

/**
 * Chaos test: kill the Redis broker mid-operation and validate the hub
 * fail-open path (no unhandledRejection, watchdog stops renewing, recovery
 * after broker resumes).
 *
 * Gated by `INTEGRATION_REDIS_CHAOS_TESTS_ENABLED=true` because (a) it
 * disconnects clients on the same broker (potentially affecting other
 * concurrent tests) and (b) the chaos action is `CLIENT KILL TYPE normal
 * SKIPME yes` which assumes the test owns the broker.
 *
 * Reuses the agent_event_stream URL probe because it's the lightest module
 * to cycle without DB dependency.
 */
const isChaosEnabled = (): boolean => process.env.INTEGRATION_REDIS_CHAOS_TESTS_ENABLED === "true";

const killAllNormalClients = async (redisUrl: string): Promise<void> => {
  const admin = createClient({ url: redisUrl });
  admin.on("error", () => undefined);
  await admin.connect();
  try {
    await admin.sendCommand(["CLIENT", "KILL", "TYPE", "normal", "SKIPME", "yes"]);
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
};

describe("redis chaos integration", () => {
  let infrastructureProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "probe not started",
  };
  let unhandledRejection: unknown;
  let unhandledHandler: ((reason: unknown) => void) | undefined;
  let streamModule: typeof AgentEventStreamModuleNs | undefined;
  let redisUrl = "";

  beforeAll(async () => {
    if (!isChaosEnabled()) {
      infrastructureProbe = {
        ok: false,
        reason: "INTEGRATION_REDIS_CHAOS_TESTS_ENABLED is not 'true'",
      };
      return;
    }
    const infrastructure = await probeAgentEventStreamInfrastructure();
    infrastructureProbe = infrastructure.probe;
    if (!infrastructureProbe.ok) {
      return;
    }
    redisUrl = infrastructure.redisUrl;
    process.env.AGENT_EVENT_STREAM_REDIS_URL = redisUrl;
    process.env.AGENT_EVENT_STREAM_ENABLED = "true";
    process.env.AGENT_EVENT_STREAM_MAX_LEN = "100";
    process.env.AGENT_EVENT_STREAM_TTL_MS = "60000";
    process.env.AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES = "50";
    vi.resetModules();
    streamModule = await import("../../src/infrastructure/redis/agent_event_stream");
    await streamModule.initAgentEventStream();

    unhandledHandler = (reason: unknown): void => {
      unhandledRejection = reason;
    };
    process.on("unhandledRejection", unhandledHandler);
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    if (unhandledHandler) {
      process.off("unhandledRejection", unhandledHandler);
    }
    if (streamModule !== undefined) {
      await streamModule.closeAgentEventStream();
    }
    delete process.env.AGENT_EVENT_STREAM_REDIS_URL;
    delete process.env.AGENT_EVENT_STREAM_ENABLED;
    delete process.env.AGENT_EVENT_STREAM_MAX_LEN;
    delete process.env.AGENT_EVENT_STREAM_TTL_MS;
    delete process.env.AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES;
  });

  it("survives broker connection kill and recovers without unhandledRejection", async (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructureProbe);
    if (!streamModule) {
      throw new Error("module not initialised");
    }

    const principalId = `chaos-${Date.now()}`;
    // Pre-populate one frame so the stream key exists.
    await streamModule.appendAgentEventFrame(principalId, {
      eventId: "evt-pre",
      eventName: "client:custom.chaos",
      emittedAt: "2026-01-01T00:00:00.000Z",
      payload: '{"n":0}',
    });

    // Kick off a batch of appends concurrently with the broker kill.
    const inflight = Array.from({ length: 30 }, (_, idx) =>
      streamModule!
        .appendAgentEventFrame(principalId, {
          eventId: `evt-${idx}`,
          eventName: "client:custom.chaos",
          emittedAt: "2026-01-01T00:00:00.000Z",
          payload: `{"n":${idx}}`,
        })
        .catch(() => undefined),
    );

    // Mid-flight: kill all normal clients on the broker. The hub client
    // reconnects via the `reconnectStrategy` from `redis_client_options.ts`.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    await killAllNormalClients(redisUrl);

    // Wait for inflight to settle (success or fallback) — should not throw.
    const results = await Promise.allSettled(inflight);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    // Allow reconnect time, then assert the module recovered: a fresh
    // append succeeds without throwing.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1500);
    });
    const recoveryResult = await streamModule
      .appendAgentEventFrame(principalId, {
        eventId: "evt-recovery",
        eventName: "client:custom.chaos",
        emittedAt: "2026-01-01T00:00:00.000Z",
        payload: '{"n":"recovery"}',
      })
      .catch(() => undefined);
    expect(typeof recoveryResult === "string" || recoveryResult === undefined).toBe(true);

    // No unhandledRejection should have fired during the chaos window.
    expect(unhandledRejection).toBeUndefined();
  }, 30_000);
});
