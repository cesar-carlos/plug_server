import { ConsumerPreparationCoordinator } from "../../src/presentation/socket/hub/scheduling/consumer_preparation_coordinator";
import { ConsumerClientSessionIndex } from "../../src/presentation/socket/hub/registries/consumer_client_session_index";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { Namespace, Server } from "socket.io";

import { stopSocketServerLifecycleTasksForTests, closeSocketServer } from "../../src/socket";
import { socketServerStates } from "../../src/socket_state";
import { TtlCache } from "../../src/shared/utils/ttl_cache";
import { env } from "../../src/shared/config/env";

type SocketServerState = Parameters<typeof stopSocketServerLifecycleTasksForTests>[0];

const createLifecycleState = (): SocketServerState => {
  const agentsNamespace = {
    adapter: { rooms: new Map<string, Set<string>>() },
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
  } as unknown as Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, unknown>;

  return {
    consumerPreparation: new ConsumerPreparationCoordinator({ perSocket: 4, perHub: 32 }),
    clientSessions: new ConsumerClientSessionIndex(),
    io: {} as Server,
    agentsNamespace,
    consumersNamespace: agentsNamespace,
    sinkDisposers: [],
    clientProfileRecipientsCacheByAgentId: new TtlCache<string, readonly string[]>(
      env.socketClientAgentProfileRecipientCacheTtlMs,
      env.socketClientAgentProfileRecipientCacheMaxSize,
    ),
    pendingAgentProfilePushByAgentId: new Map(),
    pendingApprovedAgentIdsByClientId: new Map(),
    profilePushRecipientsInFlightByAgentId: new Map(),
    customEventDistributedCountCircuit: {
      consecutiveFailures: 0,
      openedUntilEpochMs: 0,
    },
    customEventRecipientCountCache: new TtlCache(1_000, 2_048),
    conversationSweepTimer: null,
    rateLimitSweepTimer: null,
    consumerClientAgentRoomReconcileTimer: null,
    consumerClientAgentRoomReconcileStartTimeout: null,
    consumerClientAgentRoomReconcileInFlight: null,
    consumerClientAgentRoomReconcileCursor: 0,
    shuttingDown: false,
    profilePushFlushInFlight: new Set<Promise<void>>(),
  };
};

describe("socket shutdown lifecycle", () => {
  it("should close preparation admission before the notice grace period and clear client membership", async () => {
    const state = createLifecycleState();
    Object.assign(state.io, {
      of: () => state.consumersNamespace,
      close: (done: () => void) => done(),
    });
    socketServerStates.set(state.io, state);
    state.clientSessions.register("consumer", "client");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = vi.fn(() => gate);
    const pending = Array.from({ length: 5 }, () =>
      state.consumerPreparation.run("consumer", null, work),
    );
    const closing = closeSocketServer(state.io);
    expect(state.consumerPreparation.getMetrics()).toMatchObject({ active: 4, waiting: 0 });
    await expect(state.consumerPreparation.run("new-consumer", null, work)).resolves.toEqual({
      cancelled: true,
    });
    finish();
    await Promise.all(pending);
    await closing;
    expect(work).toHaveBeenCalledTimes(4);
    expect(state.clientSessions.getSortedClientIds()).toEqual([]);
    expect(socketServerStates.has(state.io)).toBe(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should await in-flight reconcile and clear timers before profile push state is reset", async () => {
    const state = createLifecycleState();
    let reconcileSettled = false;
    let resolveReconcile!: () => void;
    const reconcileGate = new Promise<void>((resolve) => {
      resolveReconcile = resolve;
    });
    state.consumerClientAgentRoomReconcileInFlight = reconcileGate.then(() => {
      reconcileSettled = true;
    });

    state.conversationSweepTimer = setInterval(() => undefined, 60_000);
    state.rateLimitSweepTimer = setInterval(() => undefined, 60_000);
    state.consumerClientAgentRoomReconcileTimer = setInterval(() => undefined, 60_000);
    state.consumerClientAgentRoomReconcileStartTimeout = setTimeout(() => undefined, 60_000);
    state.consumerClientAgentRoomReconcileCursor = 3;

    const pendingTimeout = setTimeout(() => undefined, 60_000);
    state.pendingAgentProfilePushByAgentId.set("agent-1", {
      event: {
        agentId: "agent-1",
        profileVersion: 1,
        profileUpdatedAt: new Date().toISOString(),
        changedFields: [],
        source: "test",
      },
      timeoutHandle: pendingTimeout,
    });

    const drainPromise = stopSocketServerLifecycleTasksForTests(state);
    expect(reconcileSettled).toBe(false);
    expect(state.shuttingDown).toBe(true);

    resolveReconcile();
    await drainPromise;

    expect(reconcileSettled).toBe(true);
    expect(state.consumerClientAgentRoomReconcileInFlight).toBeNull();
    expect(state.consumerClientAgentRoomReconcileCursor).toBe(0);
    expect(state.conversationSweepTimer).toBeNull();
    expect(state.rateLimitSweepTimer).toBeNull();
    expect(state.consumerClientAgentRoomReconcileTimer).toBeNull();
    expect(state.consumerClientAgentRoomReconcileStartTimeout).toBeNull();
    expect(state.pendingAgentProfilePushByAgentId.size).toBe(0);
  });

  it("should await pending profile push flushes and recipient fetches during shutdown drain", async () => {
    const state = createLifecycleState();
    let flushSettled = false;
    let recipientFetchSettled = false;
    let bootstrapFetchSettled = false;

    const flushPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        flushSettled = true;
        resolve();
      }, 20);
    });
    state.profilePushFlushInFlight.add(flushPromise);

    state.profilePushRecipientsInFlightByAgentId.set(
      "agent-1",
      new Promise<readonly string[]>((resolve) => {
        setTimeout(() => {
          recipientFetchSettled = true;
          resolve(["client-1"]);
        }, 15);
      }),
    );

    state.pendingApprovedAgentIdsByClientId.set(
      "client-1",
      new Promise<readonly string[]>((resolve) => {
        setTimeout(() => {
          bootstrapFetchSettled = true;
          resolve(["agent-1"]);
        }, 10);
      }),
    );

    const drainPromise = stopSocketServerLifecycleTasksForTests(state);
    expect(flushSettled).toBe(false);
    expect(recipientFetchSettled).toBe(false);
    expect(bootstrapFetchSettled).toBe(false);

    await drainPromise;

    expect(flushSettled).toBe(true);
    expect(recipientFetchSettled).toBe(true);
    expect(bootstrapFetchSettled).toBe(true);
    expect(state.profilePushFlushInFlight.size).toBe(0);
    expect(state.profilePushRecipientsInFlightByAgentId.size).toBe(0);
    expect(state.pendingApprovedAgentIdsByClientId.size).toBe(0);
  });
});
