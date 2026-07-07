import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { Namespace } from "socket.io";

import type { AgentProfileBroadcastEvent } from "../../../../../src/application/services/agent_profile_broadcast_sink";

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  clearConsumerSocketAgentAccessSnapshot: vi.fn(),
}));

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    clientAgentAccessQueryService: {
      listApprovedAgentIds: vi.fn(),
    },
  },
}));

import {
  mergeCoalescedAgentProfileBroadcastEvent,
  reconcileConsumerClientAgentRoomsForSocket,
  scheduleAgentProfilePush,
  type AgentProfilePushSocketServerState,
} from "../../../../../src/presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";
import { clearConsumerSocketAgentAccessSnapshot } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { TtlCache } from "../../../../../src/shared/utils/ttl_cache";
import { env } from "../../../../../src/shared/config/env";

const mockedClearSnapshot = vi.mocked(clearConsumerSocketAgentAccessSnapshot);

const createState = (): AgentProfilePushSocketServerState => {
  const consumersNamespace = {
    adapter: { rooms: new Map<string, Set<string>>() },
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
  } as unknown as Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, unknown>;

  return {
    consumersNamespace,
    clientProfileRecipientsCacheByAgentId: new TtlCache<string, readonly string[]>(
      env.socketClientAgentProfileRecipientCacheTtlMs,
      env.socketClientAgentProfileRecipientCacheMaxSize,
    ),
    pendingAgentProfilePushByAgentId: new Map(),
    profilePushRecipientsInFlightByAgentId: new Map(),
    customEventDistributedCountCircuit: {
      consecutiveFailures: 0,
      openedUntilEpochMs: 0,
    },
    shuttingDown: false,
    profilePushFlushInFlight: new Set<Promise<void>>(),
  };
};

const buildEvent = (
  overrides: Partial<AgentProfileBroadcastEvent> = {},
): AgentProfileBroadcastEvent => ({
  agentId: "agent-1",
  profileVersion: 1,
  profileUpdatedAt: "2026-05-23T10:00:00.000Z",
  source: "test",
  changedFields: ["name"],
  ...overrides,
});

describe("mergeCoalescedAgentProfileBroadcastEvent", () => {
  it("keeps the highest profileVersion and unions changedFields", () => {
    const merged = mergeCoalescedAgentProfileBroadcastEvent(
      buildEvent({ profileVersion: 1, changedFields: ["name"] }),
      buildEvent({
        profileVersion: 3,
        profileUpdatedAt: "2026-05-23T10:00:01.000Z",
        changedFields: ["description"],
        source: "sync",
      }),
    );

    expect(merged.profileVersion).toBe(3);
    expect(merged.source).toBe("sync");
    expect(merged.changedFields).toEqual(expect.arrayContaining(["name", "description"]));
    expect(merged.changedFields).toHaveLength(2);
  });
});

describe("scheduleAgentProfilePush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces bursts per agentId with trailing debounce and emits once", async () => {
    const state = createState();

    scheduleAgentProfilePush(state, buildEvent({ profileVersion: 1, changedFields: ["name"] }));
    vi.advanceTimersByTime(10);
    scheduleAgentProfilePush(
      state,
      buildEvent({
        profileVersion: 2,
        changedFields: ["description"],
        profileUpdatedAt: "2026-05-23T10:00:01.000Z",
      }),
    );
    vi.advanceTimersByTime(10);
    scheduleAgentProfilePush(
      state,
      buildEvent({
        profileVersion: 3,
        changedFields: ["tradeName"],
        profileUpdatedAt: "2026-05-23T10:00:02.000Z",
      }),
    );

    vi.advanceTimersByTime(24);
    expect(state.consumersNamespace.emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();

    expect(state.consumersNamespace.emit).toHaveBeenCalledTimes(1);
    expect(state.pendingAgentProfilePushByAgentId.size).toBe(0);
  });
});

describe("reconcileConsumerClientAgentRoomsForSocket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears agent access snapshots for client-agent rooms that are left", async () => {
    const leave = vi.fn().mockResolvedValue(undefined);
    const join = vi.fn().mockResolvedValue(undefined);
    const socket = {
      id: "sock-1",
      connected: true,
      rooms: new Set([
        "sock-1",
        "consumer:client-agent:client-1:agent-old",
        "consumer:agent-profile:agent-old",
        "consumer:agent-profile:agent-keep",
      ]),
      leave,
      join,
    };

    const result = await reconcileConsumerClientAgentRoomsForSocket(socket as never, "client-1", [
      "agent-keep",
    ]);

    expect(result.left).toBe(2);
    expect(mockedClearSnapshot).toHaveBeenCalledTimes(1);
    expect(mockedClearSnapshot).toHaveBeenCalledWith(socket, "agent-old");
    expect(leave).toHaveBeenCalledWith("consumer:client-agent:client-1:agent-old");
    expect(leave).toHaveBeenCalledWith("consumer:agent-profile:agent-old");
  });
});
