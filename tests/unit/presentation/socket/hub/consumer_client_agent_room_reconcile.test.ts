import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { Namespace, Server, Socket } from "socket.io";
import { createSocketServerState } from "../../../../../src/socket_state";
import { container } from "../../../../../src/shared/di/container";

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
  reconcileConsumerClientAgentRooms,
  scheduleAgentProfilePush,
  type AgentProfilePushSocketServerState,
} from "../../../../../src/presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";
import { clearConsumerSocketAgentAccessSnapshot } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { TtlCache } from "../../../../../src/shared/utils/ttl_cache";
import { env } from "../../../../../src/shared/config/env";

const mockedClearSnapshot = vi.mocked(clearConsumerSocketAgentAccessSnapshot);

describe("indexed room reconciliation", () => {
  const originalBatch = env.socketConsumerClientAgentRoomReconcileMaxClientsPerTick;
  const originalCache = env.socketConsumerReconcileApprovedAgentsCacheTtlMs;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(env, {
      socketConsumerClientAgentRoomReconcileMaxClientsPerTick: 2,
      socketConsumerReconcileApprovedAgentsCacheTtlMs: 0,
    });
  });
  afterEach(() => {
    Object.assign(env, {
      socketConsumerClientAgentRoomReconcileMaxClientsPerTick: originalBatch,
      socketConsumerReconcileApprovedAgentsCacheTtlMs: originalCache,
    });
  });
  const socket = (id: string): Socket =>
    ({
      id,
      connected: true,
      data: {},
      rooms: new Set(),
      join: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Socket;
  const fixture = (): {
    sockets: Map<string, Socket>;
    namespace: Namespace;
    state: ReturnType<typeof createSocketServerState>;
  } => {
    const sockets = new Map<string, Socket>();
    const namespace = { sockets } as unknown as Namespace;
    const state = createSocketServerState({} as Server, namespace, namespace);
    return { sockets, namespace, state };
  };

  it("resolves only the circular batch without scanning sockets on stable cycles", async () => {
    const { sockets, namespace, state } = fixture();
    for (const [id, clientId] of [
      ["a1", "a"],
      ["a2", "a"],
      ["b1", "b"],
      ["c1", "c"],
    ]) {
      sockets.set(id!, socket(id!));
      state.clientSessions.register(id!, clientId!);
    }
    const values = vi.spyOn(sockets, "values").mockImplementation(() => {
      throw new Error("global scan forbidden");
    });
    const sorted = state.clientSessions.getSortedClientIds();
    const query = vi
      .mocked(container.clientAgentAccessQueryService.listApprovedAgentIds)
      .mockResolvedValue(["agent"]);
    await reconcileConsumerClientAgentRooms(namespace, state);
    expect(query.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
    expect(sockets.get("a1")!.join).toHaveBeenCalledTimes(2);
    expect(sockets.get("a2")!.join).toHaveBeenCalledTimes(2);
    expect(sockets.get("c1")!.join).not.toHaveBeenCalled();
    await reconcileConsumerClientAgentRooms(namespace, state);
    expect(query.mock.calls.map((call) => call[0])).toEqual(["a", "b", "c", "a"]);
    expect(state.clientSessions.getSortedClientIds()).toBe(sorted);
    expect(values).not.toHaveBeenCalled();
    state.clientSessions.remove("a1");
    state.clientSessions.remove("a2");
    expect(state.clientSessions.getSortedClientIds()).toEqual(["b", "c"]);
  });

  it("does not join rooms for a client disconnected while the query is pending", async () => {
    const { sockets, namespace, state } = fixture();
    const consumer = socket("client");
    sockets.set(consumer.id, consumer);
    state.clientSessions.register(consumer.id, "client");
    let finish!: (agents: string[]) => void;
    vi.mocked(container.clientAgentAccessQueryService.listApprovedAgentIds).mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = reconcileConsumerClientAgentRooms(namespace, state);
    await Promise.resolve();
    consumer.connected = false;
    state.clientSessions.remove(consumer.id);
    finish(["agent"]);
    await pending;
    expect(consumer.join).not.toHaveBeenCalled();
    expect(state.clientSessions.getSortedClientIds()).toEqual([]);
  });

  it("keeps same client membership independent in two hubs", async () => {
    const first = fixture();
    const second = fixture();
    first.state.clientSessions.register("same", "client");
    second.state.clientSessions.register("same", "client");
    first.sockets.set("same", socket("same"));
    second.sockets.set("same", socket("same"));
    first.state.clientSessions.remove("same");
    vi.mocked(container.clientAgentAccessQueryService.listApprovedAgentIds).mockResolvedValue([
      "agent",
    ]);
    await reconcileConsumerClientAgentRooms(first.namespace, first.state);
    await reconcileConsumerClientAgentRooms(second.namespace, second.state);
    expect(first.sockets.get("same")!.join).not.toHaveBeenCalled();
    expect(second.sockets.get("same")!.join).toHaveBeenCalledTimes(2);
  });
});

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
