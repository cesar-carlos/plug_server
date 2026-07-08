import type { Namespace } from "socket.io";

import type { ConsumerSocketControlHandler } from "../../../application/services/consumer_socket_control_sink";
import type { LegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import {
  invalidateLocalAgentAccessSnapshotsByAgentId,
  invalidateLocalClientAgentAccessSnapshot,
  invalidateLocalUserAccessSnapshots,
} from "../consumers/consumer_socket_guard";
import {
  buildConsumerClientAgentRoom,
  buildConsumerClientRoom,
  joinConsumerClientAgentRoom,
} from "./consumer_identity_rooms";
import { invalidateApprovedAgentIdsCache } from "./scheduling/consumer_client_agent_room_reconcile";
import {
  noteConsumerClientAgentRoomGrantAttempt,
  noteConsumerClientAgentRoomGrantFetchFailed,
  noteConsumerClientAgentRoomGrantJoinFailed,
  noteConsumerClientAgentRoomGrantSocketsJoined,
} from "../../../shared/metrics/socket_consumer.metrics";
import { logger } from "../../../shared/utils/logger";

export interface ConsumerSocketControlHandlersDeps {
  readonly consumersNsp: Namespace;
  readonly clientProfileRecipientsCacheByAgentId: { readonly delete: (agentId: string) => void };
  readonly disconnectConsumerSocketsInRoom: (
    namespace: Namespace,
    room: string,
    payload: LegacySocketAppErrorPayload,
    logContext: Record<string, unknown>,
  ) => Promise<number>;
}

/**
 * Builds the `ConsumerSocketControlSinkHandler` whose callbacks react to
 * domain events (account blocked / access revoked / cache invalidations /
 * access granted) by mutating live consumer Socket.IO sessions. Extracted
 * from `createSocketServer` so the cross-cutting room/snapshot handling
 * lives in one focused module instead of inflating the bootstrap function.
 */
export const buildConsumerSocketControlHandlers = (
  deps: ConsumerSocketControlHandlersDeps,
): ConsumerSocketControlHandler => {
  const { consumersNsp, clientProfileRecipientsCacheByAgentId, disconnectConsumerSocketsInRoom } =
    deps;

  return {
    disconnectPrincipal: async (event) => {
      const room = `consumer:principal:${event.principalType}:${event.principalId}`;
      await disconnectConsumerSocketsInRoom(
        consumersNsp,
        room,
        buildLegacySocketAppErrorPayload(
          "ACCOUNT_BLOCKED",
          event.principalType === "client" ? "Client account is blocked" : "Account is blocked",
        ),
        {
          principalType: event.principalType,
          principalId: event.principalId,
          reason: event.reason,
        },
      );
    },
    revokeClientAccess: async (event) => {
      invalidateApprovedAgentIdsCache(event.clientId);
      clientProfileRecipientsCacheByAgentId.delete(event.agentId);
      await disconnectConsumerSocketsInRoom(
        consumersNsp,
        buildConsumerClientAgentRoom({
          clientId: event.clientId,
          agentId: event.agentId,
        }),
        buildLegacySocketAppErrorPayload(
          "AGENT_ACCESS_REVOKED",
          `Client access to agent ${event.agentId} was revoked`,
        ),
        {
          clientId: event.clientId,
          agentId: event.agentId,
          reason: event.reason,
        },
      );
    },
    invalidateClientAgentAccessSnapshot: async (event) => {
      try {
        invalidateLocalClientAgentAccessSnapshot(consumersNsp, event.clientId, event.agentId);
      } catch (error: unknown) {
        logger.warn("consumer_socket_agent_access_snapshot_invalidate_failed", {
          clientId: event.clientId,
          agentId: event.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    invalidateAgentAccessSnapshot: async (event) => {
      try {
        invalidateLocalAgentAccessSnapshotsByAgentId(consumersNsp, event.agentId);
      } catch (error: unknown) {
        logger.warn("consumer_socket_agent_access_snapshot_invalidate_by_agent_failed", {
          agentId: event.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    invalidateUserAccessSnapshot: async (event) => {
      try {
        invalidateLocalUserAccessSnapshots(consumersNsp, event.userId);
      } catch (error: unknown) {
        logger.warn("consumer_socket_agent_access_snapshot_invalidate_by_user_failed", {
          userId: event.userId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    grantClientAccess: async (event) => {
      invalidateApprovedAgentIdsCache(event.clientId);
      noteConsumerClientAgentRoomGrantAttempt();
      const clientRoom = buildConsumerClientRoom(event.clientId);
      try {
        const sockets = await consumersNsp.in(clientRoom).fetchSockets();
        for (const remote of sockets) {
          try {
            await joinConsumerClientAgentRoom(remote, {
              clientId: event.clientId,
              agentId: event.agentId,
            });
            noteConsumerClientAgentRoomGrantSocketsJoined(1);
          } catch (error: unknown) {
            noteConsumerClientAgentRoomGrantJoinFailed();
            logger.warn("consumer_socket_client_agent_room_grant_failed", {
              clientId: event.clientId,
              agentId: event.agentId,
              socketId: remote.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error: unknown) {
        noteConsumerClientAgentRoomGrantFetchFailed();
        logger.warn("consumer_socket_client_agent_room_grant_fetch_failed", {
          clientId: event.clientId,
          agentId: event.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
};
