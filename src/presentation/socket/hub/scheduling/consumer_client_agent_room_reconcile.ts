import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { Namespace, Socket } from "socket.io";

import type { AgentProfileBroadcastEvent } from "../../../../application/services/agent_profile_broadcast_sink";
import { container } from "../../../../shared/di/container";
import { env } from "../../../../shared/config/env";
import { socketEvents } from "../../../../shared/constants/socket_events";
import {
  noteConsumerClientAgentRoomBootstrapCompleted,
  noteConsumerClientAgentRoomBootstrapFailed,
  noteConsumerClientAgentRoomBootstrapFetchReused,
  noteConsumerClientAgentRoomBootstrapStarted,
  noteConsumerClientAgentRoomReconcileDeferred,
  noteConsumerClientAgentRoomReconcileFailed,
  noteConsumerClientAgentRoomReconcileFinished,
  noteConsumerClientAgentRoomReconcileRoomsJoined,
  noteConsumerClientAgentRoomReconcileRoomsLeft,
  noteConsumerClientAgentRoomReconcileStarted,
  noteConsumerClientAgentRoomReconcileTickSkipped,
  noteConsumerProfilePushBatch,
  noteConsumerProfilePushCoalesced,
  noteConsumerProfilePushRecipientFetchReused,
} from "../../../../shared/metrics/socket_consumer.metrics";
import type { JwtAccessPayload } from "../../../../shared/utils/jwt";
import { logger } from "../../../../shared/utils/logger";
import {
  encodePayloadFrameHotPath,
  type PayloadFrameEnvelope,
} from "../../../../shared/utils/payload_frame";
import type { TtlCache } from "../../../../shared/utils/ttl_cache";
import {
  buildConsumerAgentProfileRoom,
  buildConsumerClientAgentRoom,
} from "../consumer_identity_rooms";
import { resetCustomEventDistributedCountCircuit } from "../custom_events/custom_socket_event_distributed_count_circuit";
import type { DistributedCountCircuitState } from "../custom_events/custom_socket_event_distributed_count_circuit";

export type PendingAgentProfilePush = {
  event: AgentProfileBroadcastEvent;
  timeoutHandle: NodeJS.Timeout;
};

export type AgentProfilePushSocketServerState = {
  readonly consumersNamespace: Namespace;
  readonly clientProfileRecipientsCacheByAgentId: TtlCache<string, readonly string[]>;
  readonly pendingAgentProfilePushByAgentId: Map<string, PendingAgentProfilePush>;
  readonly profilePushRecipientsInFlightByAgentId: Map<string, Promise<readonly string[]>>;
  readonly customEventDistributedCountCircuit: DistributedCountCircuitState;
  shuttingDown: boolean;
  profilePushFlushInFlight: Set<Promise<void>>;
};

const clientAgentProfilePushDebounceMs = 25;

/** Unions `changedFields` and keeps the highest `profileVersion` within a debounce window. */
export const mergeCoalescedAgentProfileBroadcastEvent = (
  existing: AgentProfileBroadcastEvent,
  incoming: AgentProfileBroadcastEvent,
): AgentProfileBroadcastEvent => {
  if (incoming.profileVersion > existing.profileVersion) {
    const mergedFields = new Set([...existing.changedFields, ...incoming.changedFields]);
    return {
      ...incoming,
      changedFields: [...mergedFields],
    };
  }

  if (incoming.profileVersion < existing.profileVersion) {
    const mergedFields = new Set([...existing.changedFields, ...incoming.changedFields]);
    return {
      ...existing,
      changedFields: [...mergedFields],
    };
  }

  const mergedFields = new Set([...existing.changedFields, ...incoming.changedFields]);
  const existingUpdatedAt = existing.profileUpdatedAt ?? "";
  const incomingUpdatedAt = incoming.profileUpdatedAt ?? "";
  const profileUpdatedAt =
    incomingUpdatedAt >= existingUpdatedAt ? incoming.profileUpdatedAt : existing.profileUpdatedAt;
  return {
    agentId: existing.agentId,
    profileVersion: existing.profileVersion,
    profileUpdatedAt,
    source: incoming.source,
    changedFields: [...mergedFields],
  };
};

export const encodeAgentProfilePushPayloadFrame = (
  event: AgentProfileBroadcastEvent,
): PayloadFrameEnvelope =>
  encodePayloadFrameHotPath({
    success: true,
    agent_id: event.agentId,
    profile_version: event.profileVersion,
    profileUpdatedAt: event.profileUpdatedAt,
    changed_fields: event.changedFields,
    source: event.source,
  });

const countLocalSocketsInRoom = (namespace: Namespace, room: string): number =>
  namespace.adapter.rooms.get(room)?.size ?? 0;

const getCachedProfilePushRecipients = async (
  state: AgentProfilePushSocketServerState,
  agentId: string,
): Promise<readonly string[]> => {
  const cached = state.clientProfileRecipientsCacheByAgentId.get(agentId);
  if (cached !== undefined) {
    return cached;
  }

  const existingFetch = state.profilePushRecipientsInFlightByAgentId.get(agentId);
  if (existingFetch) {
    noteConsumerProfilePushRecipientFetchReused();
    return existingFetch;
  }

  const fetchPromise = (async (): Promise<readonly string[]> => {
    try {
      const clientIds =
        await container.clientAgentAccessQueryService.listActiveApprovedClientIdsForAgent(agentId);
      state.clientProfileRecipientsCacheByAgentId.set(agentId, clientIds);
      return clientIds;
    } finally {
      state.profilePushRecipientsInFlightByAgentId.delete(agentId);
    }
  })();
  state.profilePushRecipientsInFlightByAgentId.set(agentId, fetchPromise);
  return fetchPromise;
};

const flushAgentProfilePush = async (
  state: AgentProfilePushSocketServerState,
  agentId: string,
): Promise<void> => {
  if (state.shuttingDown) {
    return;
  }

  const pending = state.pendingAgentProfilePushByAgentId.get(agentId);
  if (!pending) {
    return;
  }
  state.pendingAgentProfilePushByAgentId.delete(agentId);

  const recipientRoom = buildConsumerAgentProfileRoom(agentId);
  const cachedRecipients = state.clientProfileRecipientsCacheByAgentId.get(agentId);
  noteConsumerProfilePushBatch(
    cachedRecipients?.length ?? countLocalSocketsInRoom(state.consumersNamespace, recipientRoom),
  );

  const frame = encodeAgentProfilePushPayloadFrame(pending.event);
  state.consumersNamespace.to(recipientRoom).emit(socketEvents.clientAgentProfileUpdated, frame);
};

const scheduleAgentProfilePushFlush = (
  state: AgentProfilePushSocketServerState,
  agentId: string,
  timeoutHandle: NodeJS.Timeout,
): void => {
  const pending = state.pendingAgentProfilePushByAgentId.get(agentId);
  if (!pending || pending.timeoutHandle !== timeoutHandle) {
    return;
  }

  const flushPromise = flushAgentProfilePush(state, agentId).catch((error: unknown) => {
    logger.warn("client_agent_profile_push_failed", {
      agentId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
  state.profilePushFlushInFlight.add(flushPromise);
  void flushPromise.finally(() => {
    state.profilePushFlushInFlight.delete(flushPromise);
  });
};

const armAgentProfilePushDebounce = (
  state: AgentProfilePushSocketServerState,
  agentId: string,
): NodeJS.Timeout => {
  const timeoutHandle = setTimeout(() => {
    scheduleAgentProfilePushFlush(state, agentId, timeoutHandle);
  }, clientAgentProfilePushDebounceMs);
  timeoutHandle.unref?.();
  return timeoutHandle;
};

export const scheduleAgentProfilePush = (
  state: AgentProfilePushSocketServerState,
  event: AgentProfileBroadcastEvent,
): void => {
  if (state.shuttingDown) {
    return;
  }

  const existing = state.pendingAgentProfilePushByAgentId.get(event.agentId);
  if (existing) {
    existing.event = mergeCoalescedAgentProfileBroadcastEvent(existing.event, event);
    clearTimeout(existing.timeoutHandle);
    existing.timeoutHandle = armAgentProfilePushDebounce(state, event.agentId);
    noteConsumerProfilePushCoalesced();
    return;
  }

  if (state.clientProfileRecipientsCacheByAgentId.get(event.agentId) === undefined) {
    void getCachedProfilePushRecipients(state, event.agentId).catch((error: unknown) => {
      logger.warn("client_agent_profile_push_recipient_cache_prime_failed", {
        agentId: event.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  state.pendingAgentProfilePushByAgentId.set(event.agentId, {
    event,
    timeoutHandle: armAgentProfilePushDebounce(state, event.agentId),
  });
};

export type ConsumerClientAgentRoomBootstrapState = AgentProfilePushSocketServerState & {
  readonly pendingApprovedAgentIdsByClientId: Map<string, Promise<readonly string[]>>;
};

export const clearConsumerProfilePushState = (
  state: ConsumerClientAgentRoomBootstrapState,
  hasOtherOpenCircuit: () => boolean,
): void => {
  for (const pending of state.pendingAgentProfilePushByAgentId.values()) {
    clearTimeout(pending.timeoutHandle);
  }
  state.pendingAgentProfilePushByAgentId.clear();
  state.pendingApprovedAgentIdsByClientId.clear();
  state.profilePushRecipientsInFlightByAgentId.clear();
  state.clientProfileRecipientsCacheByAgentId.clear();
  resetCustomEventDistributedCountCircuit(
    state.customEventDistributedCountCircuit,
    hasOtherOpenCircuit,
  );
};

export const backfillConsumerApprovedAgentRooms = async (
  state: ConsumerClientAgentRoomBootstrapState,
  socket: Socket,
  input: {
    readonly getUserId: (socket: Socket) => string | null;
    readonly reconcileRoomsForSocket: (
      socket: Socket,
      clientId: string,
      approvedAgentIds: readonly string[],
    ) => Promise<{ joined: number; left: number }>;
  },
): Promise<void> => {
  if (state.shuttingDown) {
    return;
  }

  const user = socket.data.user as JwtAccessPayload | undefined;
  if (user?.principal_type !== "client" || typeof user.sub !== "string" || user.sub.trim() === "") {
    return;
  }
  const startedAt = noteConsumerClientAgentRoomBootstrapStarted();
  try {
    const clientId = user.sub.trim();
    const existingFetch = state.pendingApprovedAgentIdsByClientId.get(clientId);
    if (existingFetch) {
      noteConsumerClientAgentRoomBootstrapFetchReused();
    }
    const approvedAgentIds =
      existingFetch ??
      (async (): Promise<readonly string[]> => {
        try {
          return await container.clientAgentAccessQueryService.listApprovedAgentIds(clientId);
        } finally {
          state.pendingApprovedAgentIdsByClientId.delete(clientId);
        }
      })();
    if (!existingFetch) {
      state.pendingApprovedAgentIdsByClientId.set(clientId, approvedAgentIds);
    }
    const result = await input.reconcileRoomsForSocket(socket, clientId, await approvedAgentIds);
    if (result.joined > 0) {
      noteConsumerClientAgentRoomReconcileRoomsJoined(result.joined);
    }
    if (result.left > 0) {
      noteConsumerClientAgentRoomReconcileRoomsLeft(result.left);
    }
    noteConsumerClientAgentRoomBootstrapCompleted(startedAt);
  } catch (error: unknown) {
    noteConsumerClientAgentRoomBootstrapFailed();
    logger.warn("consumer_socket_client_agent_room_bootstrap_failed", {
      socketId: socket.id,
      userId: input.getUserId(socket),
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export const listConsumerApprovedAgentRooms = (
  clientId: string,
  approvedAgentIds: readonly string[],
): string[] => {
  const rooms = new Set<string>();
  for (const agentId of approvedAgentIds) {
    rooms.add(
      buildConsumerClientAgentRoom({
        clientId,
        agentId,
      }),
    );
    rooms.add(buildConsumerAgentProfileRoom(agentId));
  }
  return [...rooms];
};

export const buildConsumerClientAgentRoomPrefix = (clientId: string): string =>
  `consumer:client-agent:${clientId}:`;

export const buildConsumerAgentProfileRoomPrefix = (): string => "consumer:agent-profile:";

export const selectReconcileClientEntries = <T>(
  entries: readonly T[],
  cursor: number,
  maxClientsPerTick: number,
): {
  readonly selected: readonly T[];
  readonly nextCursor: number;
  readonly deferredCount: number;
} => {
  if (entries.length === 0) {
    return { selected: [], nextCursor: 0, deferredCount: 0 };
  }

  const size = Math.min(entries.length, Math.max(1, maxClientsPerTick));
  const normalizedCursor = ((cursor % entries.length) + entries.length) % entries.length;
  const ordered = [...entries.slice(normalizedCursor), ...entries.slice(0, normalizedCursor)];
  return {
    selected: ordered.slice(0, size),
    nextCursor: (normalizedCursor + size) % entries.length,
    deferredCount: entries.length - size,
  };
};

export const resolveConsumerClientAgentRoomReconcileStartDelayMs = (
  maxJitterMs: number,
  randomValue = Math.random(),
): number => {
  if (maxJitterMs <= 0) {
    return 0;
  }
  const normalizedRandom = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
  return Math.floor(normalizedRandom * (maxJitterMs + 1));
};

const forEachWithConcurrencyLimit = async <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  const maxConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;

  await Promise.all(
    Array.from({ length: maxConcurrency }, async () => {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        await worker(items[currentIndex]!);
      }
    }),
  );
};

export const reconcileConsumerClientAgentRoomsForSocket = async (
  socket: Socket,
  clientId: string,
  approvedAgentIds: readonly string[],
): Promise<{ joined: number; left: number }> => {
  if (!socket.connected) {
    return { joined: 0, left: 0 };
  }

  const expectedRooms = new Set(listConsumerApprovedAgentRooms(clientId, approvedAgentIds));
  const currentRooms = [...socket.rooms].filter(
    (room) =>
      room.startsWith(buildConsumerClientAgentRoomPrefix(clientId)) ||
      room.startsWith(buildConsumerAgentProfileRoomPrefix()),
  );

  /**
   * Compute the leave/join sets first, then fire each set in parallel via
   * `Promise.all`. With many agents per client (~60+), the previous sequential
   * `await socket.leave/join` would walk through ~120 round-trips on the
   * Socket.IO adapter; the parallel pattern collapses each set into a single
   * adapter batch.
   */
  const roomsToLeave = currentRooms.filter((room) => !expectedRooms.has(room));
  const roomsToJoin: string[] = [];
  for (const room of expectedRooms) {
    if (!socket.rooms.has(room)) {
      roomsToJoin.push(room);
    }
  }

  if (roomsToLeave.length > 0) {
    await Promise.all(roomsToLeave.map((room) => socket.leave(room)));
  }
  if (roomsToJoin.length > 0) {
    await Promise.all(roomsToJoin.map((room) => socket.join(room)));
  }

  return { joined: roomsToJoin.length, left: roomsToLeave.length };
};

export type ConsumerClientAgentRoomReconcileState = ConsumerClientAgentRoomBootstrapState & {
  consumerClientAgentRoomReconcileTimer: NodeJS.Timeout | null;
  consumerClientAgentRoomReconcileStartTimeout: NodeJS.Timeout | null;
  consumerClientAgentRoomReconcileInFlight: Promise<void> | null;
  consumerClientAgentRoomReconcileCursor: number;
};

export const reconcileConsumerClientAgentRooms = async (
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, unknown>,
  state: ConsumerClientAgentRoomReconcileState,
): Promise<void> => {
  if (state.shuttingDown) {
    return;
  }

  const socketsByClientId = new Map<string, Socket[]>();
  for (const socket of namespace.sockets.values()) {
    const user = (socket.data as { user?: JwtAccessPayload }).user;
    if (user?.principal_type !== "client") {
      continue;
    }
    const clientId = user.sub?.trim();
    if (!clientId) {
      continue;
    }
    const existing = socketsByClientId.get(clientId);
    if (existing !== undefined) {
      existing.push(socket);
      continue;
    }
    socketsByClientId.set(clientId, [socket]);
  }

  if (socketsByClientId.size === 0) {
    return;
  }

  const selectedBatch = selectReconcileClientEntries(
    [...socketsByClientId.entries()].sort(([leftClientId], [rightClientId]) =>
      leftClientId.localeCompare(rightClientId),
    ),
    state.consumerClientAgentRoomReconcileCursor,
    env.socketConsumerClientAgentRoomReconcileMaxClientsPerTick,
  );
  state.consumerClientAgentRoomReconcileCursor = selectedBatch.nextCursor;
  if (selectedBatch.deferredCount > 0) {
    noteConsumerClientAgentRoomReconcileDeferred(selectedBatch.deferredCount);
  }

  const socketCount = selectedBatch.selected.reduce((sum, [, sockets]) => sum + sockets.length, 0);
  noteConsumerClientAgentRoomReconcileStarted(selectedBatch.selected.length, socketCount);

  try {
    await forEachWithConcurrencyLimit(
      selectedBatch.selected,
      env.socketConsumerClientAgentRoomReconcileConcurrency,
      async ([clientId, sockets]) => {
        try {
          const approvedAgentIds =
            await container.clientAgentAccessQueryService.listApprovedAgentIds(clientId);
          for (const socket of sockets) {
            const result = await reconcileConsumerClientAgentRoomsForSocket(
              socket,
              clientId,
              approvedAgentIds,
            );
            if (result.joined > 0) {
              noteConsumerClientAgentRoomReconcileRoomsJoined(result.joined);
            }
            if (result.left > 0) {
              noteConsumerClientAgentRoomReconcileRoomsLeft(result.left);
            }
          }
        } catch (error: unknown) {
          noteConsumerClientAgentRoomReconcileFailed();
          logger.warn("consumer_socket_client_agent_room_reconcile_failed", {
            clientId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
  } finally {
    noteConsumerClientAgentRoomReconcileFinished();
  }
};

export const scheduleConsumerClientAgentRoomReconcile = (
  state: ConsumerClientAgentRoomReconcileState,
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, unknown>,
): void => {
  const runTick = (): void => {
    if (state.shuttingDown) {
      return;
    }
    if (state.consumerClientAgentRoomReconcileInFlight !== null) {
      noteConsumerClientAgentRoomReconcileTickSkipped();
      return;
    }
    state.consumerClientAgentRoomReconcileInFlight = reconcileConsumerClientAgentRooms(
      namespace,
      state,
    )
      .catch((error: unknown) => {
        logger.warn("consumer_socket_client_agent_room_reconcile_tick_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        state.consumerClientAgentRoomReconcileInFlight = null;
      });
  };

  const startInterval = (): void => {
    runTick();
    state.consumerClientAgentRoomReconcileTimer = setInterval(
      runTick,
      env.socketConsumerClientAgentRoomReconcileIntervalMs,
    );
    state.consumerClientAgentRoomReconcileTimer.unref?.();
  };

  const jitterMs = env.socketConsumerClientAgentRoomReconcileStartJitterMs;
  if (jitterMs <= 0) {
    startInterval();
    return;
  }

  state.consumerClientAgentRoomReconcileStartTimeout = setTimeout(
    startInterval,
    resolveConsumerClientAgentRoomReconcileStartDelayMs(jitterMs),
  );
  state.consumerClientAgentRoomReconcileStartTimeout.unref?.();
};
