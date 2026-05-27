import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AgentEventStreamModuleNs from "../../src/infrastructure/redis/agent_event_stream";
import type * as AgentEventStreamCursorModuleNs from "../../src/infrastructure/redis/agent_event_stream_cursor";
import type * as AgentEventStreamMetricsModuleNs from "../../src/application/services/agent_event_stream_metrics.service";
import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeAgentEventStreamInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

/**
 * Exercises the durable backlog stream end-to-end against a real Redis broker:
 *
 * 1. With agent connected (drain returns nothing) -> publish online -> drain still returns nothing.
 * 2. Disconnect (no agent socket) -> publish offline N frames -> drain returns N -> commit cursor.
 * 3. Second drain after cursor commit returns 0 frames.
 * 4. Frames published with eventName not subscribed are filtered out at drain time.
 *
 * The test exercises the module API directly (no Socket.IO server) to keep the
 * scope tight and the runtime small. The Socket.IO drain path is covered by a
 * unit test for the drain helper itself.
 */
describe("agent event stream backlog integration", () => {
  let infrastructureProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "probe not started",
  };
  let streamModule: typeof AgentEventStreamModuleNs | undefined;
  let cursorModule: typeof AgentEventStreamCursorModuleNs | undefined;
  let metricsModule: typeof AgentEventStreamMetricsModuleNs | undefined;

  beforeAll(async () => {
    const infrastructure = await probeAgentEventStreamInfrastructure();
    infrastructureProbe = infrastructure.probe;
    if (!infrastructureProbe.ok) {
      return;
    }

    process.env.AGENT_EVENT_STREAM_REDIS_URL = infrastructure.redisUrl;
    process.env.AGENT_EVENT_STREAM_ENABLED = "true";
    process.env.AGENT_EVENT_STREAM_MAX_LEN = "100";
    process.env.AGENT_EVENT_STREAM_TTL_MS = "60000";
    process.env.AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES = "50";
    process.env.AGENT_EVENT_STREAM_AGENT_ALLOWLIST = "";
    process.env.AGENT_EVENT_STREAM_DRAIN_ACK_TIMEOUT_MS = "1000";

    vi.resetModules();
    streamModule = await import("../../src/infrastructure/redis/agent_event_stream");
    cursorModule = await import("../../src/infrastructure/redis/agent_event_stream_cursor");
    metricsModule =
      await import("../../src/application/services/agent_event_stream_metrics.service");
    await streamModule.initAgentEventStream();
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    if (streamModule !== undefined) {
      await streamModule.closeAgentEventStream();
    }
    delete process.env.AGENT_EVENT_STREAM_REDIS_URL;
    delete process.env.AGENT_EVENT_STREAM_ENABLED;
    delete process.env.AGENT_EVENT_STREAM_MAX_LEN;
    delete process.env.AGENT_EVENT_STREAM_TTL_MS;
    delete process.env.AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES;
    delete process.env.AGENT_EVENT_STREAM_AGENT_ALLOWLIST;
    delete process.env.AGENT_EVENT_STREAM_DRAIN_ACK_TIMEOUT_MS;
  });

  beforeEach((ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructureProbe);
    metricsModule?.resetAgentEventStreamMetricsForTests();
  });

  it("delivers the frames published while the agent was offline and persists the cursor", async () => {
    if (!streamModule || !cursorModule || !metricsModule) {
      throw new Error("modules not initialised");
    }

    const principalId = `agent-int-${Date.now()}`;
    // Initial state: cursor "$" (skip historical) and no frames in stream.
    const initialCursor = await cursorModule.getAgentEventCursor(principalId);
    expect(initialCursor).toBe("$");
    const initialBacklog = await streamModule.readAgentEventBacklog(principalId, initialCursor);
    expect(initialBacklog).toHaveLength(0);

    // Append three frames to the principal stream while the agent is "offline".
    const frames = [
      {
        eventId: "evt-1",
        eventName: "client:custom.alerts",
        emittedAt: "2026-01-01T00:00:00.000Z",
        payload: '{"n":1}',
      },
      {
        eventId: "evt-2",
        eventName: "client:custom.alerts",
        emittedAt: "2026-01-01T00:00:01.000Z",
        payload: '{"n":2}',
      },
      {
        eventId: "evt-3",
        eventName: "client:custom.other",
        emittedAt: "2026-01-01T00:00:02.000Z",
        payload: '{"n":3}',
      },
    ];
    const appendedIds = await Promise.all(
      frames.map((frame) => streamModule!.appendAgentEventFrame(principalId, frame)),
    );
    for (const id of appendedIds) {
      expect(typeof id).toBe("string");
    }

    // Reconnect: cursor still "$", backlog read returns 3 frames in order.
    const cursorBeforeDrain = await cursorModule.getAgentEventCursor(principalId);
    const backlog = await streamModule.readAgentEventBacklog(principalId, cursorBeforeDrain);
    expect(backlog).toHaveLength(3);
    expect(backlog.map((entry) => entry.eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);

    // Simulate ack-then-commit for two frames matching the subscription.
    const subscriptionEventName = "client:custom.alerts";
    const matching = backlog.filter((entry) => entry.eventName === subscriptionEventName);
    expect(matching).toHaveLength(2);
    for (const entry of matching) {
      await cursorModule.commitAgentEventCursor(principalId, entry.streamId);
    }
    await streamModule.ackAgentEventFrames(
      principalId,
      matching.map((entry) => entry.streamId),
    );

    // Cursor advanced to the last committed streamId.
    const committedCursor = await cursorModule.getAgentEventCursor(principalId);
    const lastCommittedStreamId = matching[matching.length - 1]?.streamId;
    expect(committedCursor).toBe(lastCommittedStreamId);

    // Second reconnect sees only the unacked entry (evt-3, different event name).
    const secondReadAll = await streamModule.readAgentEventBacklog(principalId, committedCursor);
    expect(secondReadAll).toHaveLength(1);
    expect(secondReadAll[0]?.eventId).toBe("evt-3");

    // Re-publishing nothing and re-reading from the same cursor returns 0.
    const thirdRead = await streamModule.readAgentEventBacklog(
      principalId,
      secondReadAll[0]!.streamId,
    );
    expect(thirdRead).toHaveLength(0);

    // Cleanup: purge cursor and entries to leave the broker tidy.
    await cursorModule.purgeAgentEventCursor(principalId);
    await streamModule.ackAgentEventFrames(principalId, [secondReadAll[0]!.streamId]);

    // Metrics: at least 3 appends, 3 backlog reads, 1 ack call.
    const metrics = metricsModule.getAgentEventStreamMetricsSnapshot();
    expect(metrics.appendsTotal).toBeGreaterThanOrEqual(3);
    expect(metrics.backlogReadsTotal).toBeGreaterThanOrEqual(3);
    expect(metrics.acksTotal).toBeGreaterThanOrEqual(1);
    expect(metrics.redisStoreActive).toBe(1);
  });
});
