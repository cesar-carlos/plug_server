import type { Namespace } from "socket.io";

import type { RelayConversation } from "./presentation/socket/hub/registries/conversation_registry";
import {
  countDistributedRoomRecipients,
  resetCustomEventDistributedCountCircuit,
} from "./presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit";
import {
  buildRelayConversationEndedPayload,
  finalizeExpiredConversations,
} from "./presentation/socket/hub/relay/rpc_bridge";
import { runConsumerSocketDisconnectCleanup as runConsumerSocketDisconnectCleanupImpl } from "./presentation/socket/hub/register_consumer_socket_handlers";
import {
  noteAgentRoomDisconnectTriggered,
  noteConsumerRoomDisconnectTriggered,
} from "./shared/metrics/socket_consumer.metrics";
import { env } from "./shared/config/env";
import { socketEvents } from "./shared/constants/socket_events";
import type { LegacySocketAppErrorPayload } from "./shared/constants/socket_app_error";
import { logger } from "./shared/utils/logger";
import {
  hasOtherOpenCustomEventDistributedCountCircuit,
  type HubNamespace,
  type HubSocket,
  type RoomRecipientCount,
  type RoomRemoteSocket,
  type SocketServerState,
} from "./socket_state";

export { runAgentSocketDisconnectCleanup } from "./presentation/socket/hub/register_agent_socket_handlers";

export const getUserId = (socket: HubSocket): string | null =>
  typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;

export const countLocalSocketsInRoom = (namespace: Namespace, room: string): number =>
  namespace.adapter.rooms.get(room)?.size ?? 0;

export const resetStateCustomEventDistributedCountCircuit = (
  state: SocketServerState,
  nowEpochMs = Date.now(),
): void => {
  resetCustomEventDistributedCountCircuit(
    state.customEventDistributedCountCircuit,
    () => hasOtherOpenCustomEventDistributedCountCircuit(state, nowEpochMs),
    nowEpochMs,
  );
};

export const countSocketsInRoom = async (
  state: SocketServerState,
  namespace: Namespace,
  room: string,
  options?: { readonly captureSockets?: boolean },
): Promise<RoomRecipientCount> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  if (options?.captureSockets === true) {
    /**
     * Capture path: caller wants the underlying sockets so it can extract
     * `principalId` (or other per-socket data) without paying a second
     * `fetchSockets()` cluster RPC. We use `fetchDistributedSockets` so the
     * count function returns `fetchedSockets` 1:1 with `recipients`.
     * Never served from the short TTL cache — sockets go stale immediately.
     */
    return countDistributedRoomRecipients<RoomRemoteSocket>({
      circuit: state.customEventDistributedCountCircuit,
      localRecipients,
      room,
      fetchDistributedSockets: async () =>
        (await namespace.in(room).fetchSockets()) as unknown as ReadonlyArray<RoomRemoteSocket>,
      onCircuitReset: () => resetStateCustomEventDistributedCountCircuit(state),
    });
  }

  const cacheTtlMs = env.socketCustomEventRecipientCountCacheTtlMs;
  const cacheKey = `${namespace.name}:${room}`;
  if (cacheTtlMs > 0) {
    const cached = state.customEventRecipientCountCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  const counted = await countDistributedRoomRecipients({
    circuit: state.customEventDistributedCountCircuit,
    localRecipients,
    room,
    fetchDistributedCount: async () => (await namespace.in(room).fetchSockets()).length,
    onCircuitReset: () => resetStateCustomEventDistributedCountCircuit(state),
  });

  const result: RoomRecipientCount = {
    recipients: counted.recipients,
    recipientCountBestEffort: counted.recipientCountBestEffort,
    recipientCountLocalOnly: counted.recipientCountLocalOnly,
  };

  if (cacheTtlMs > 0) {
    state.customEventRecipientCountCache.set(cacheKey, result);
  }

  return result;
};

/**
 * Returns the number of *local* sockets found in the room at the moment of the call.
 * The actual disconnect (via `disconnectSockets`) is cluster-wide when a Redis adapter
 * is configured. Do not use the return value as total-disconnected in multi-replica metrics.
 */
export const disconnectAgentSocketsInRoom = async (
  namespace: Namespace,
  room: string,
  payload: LegacySocketAppErrorPayload,
  logContext: Record<string, unknown>,
): Promise<number> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  noteAgentRoomDisconnectTriggered();
  namespace.to(room).emit(socketEvents.appError, payload);
  namespace.in(room).disconnectSockets(true);
  if (localRecipients > 0) {
    logger.info("agent_socket_sessions_disconnected", {
      room,
      localDisconnectedCount: localRecipients,
      ...logContext,
    });
  }
  return localRecipients;
};

/**
 * Returns the number of *local* sockets found in the room at the moment of the call.
 * The actual disconnect (via `disconnectSockets`) is cluster-wide when a Redis adapter
 * is configured. Do not use the return value as total-disconnected in multi-replica metrics.
 */
export const disconnectConsumerSocketsInRoom = async (
  namespace: Namespace,
  room: string,
  payload: LegacySocketAppErrorPayload,
  logContext: Record<string, unknown>,
): Promise<number> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  noteConsumerRoomDisconnectTriggered();
  namespace.to(room).emit(socketEvents.appError, payload);
  namespace.in(room).disconnectSockets(true);
  if (localRecipients > 0) {
    logger.info("consumer_socket_sessions_disconnected", {
      room,
      localDisconnectedCount: localRecipients,
      ...logContext,
    });
  }
  return localRecipients;
};

export const runConsumerSocketDisconnectCleanup = (
  socket: HubSocket,
  agentsNsp: HubNamespace,
): void => {
  runConsumerSocketDisconnectCleanupImpl(socket, agentsNsp, getUserId);
};

export const runExpiredConversationCleanup = (
  expiredConversations: readonly RelayConversation[],
  consumersNsp: HubNamespace,
  agentsNsp: HubNamespace,
): void => {
  finalizeExpiredConversations(
    expiredConversations,
    (conversation) => {
      const consumerSocket = consumersNsp.sockets.get(conversation.consumerSocketId);
      consumerSocket?.emit(
        socketEvents.relayConversationEnded,
        buildRelayConversationEndedPayload(conversation.conversationId, "expired"),
      );
    },
    (conversation) => {
      const agentSocket = agentsNsp.sockets.get(conversation.agentSocketId);
      agentSocket?.emit(
        socketEvents.relayConversationEnded,
        buildRelayConversationEndedPayload(conversation.conversationId, "expired"),
      );
    },
  );
};
