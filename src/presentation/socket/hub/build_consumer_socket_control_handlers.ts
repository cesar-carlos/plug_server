import type { Namespace } from "socket.io";

import type { ConsumerSocketControlHandler } from "../../../application/services/consumer_socket_control_sink";
import type { LegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import {
  clearAllConsumerSocketAgentAccessSnapshots,
  clearConsumerSocketAgentAccessSnapshot,
} from "../consumers/consumer_socket_guard";
import {
  buildConsumerAgentProfileRoom,
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
        const sockets = await consumersNsp
          .in(buildConsumerClientRoom(event.clientId))
          .fetchSockets();
        for (const remote of sockets) {
          clearConsumerSocketAgentAccessSnapshot(remote, event.agentId);
        }
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
        const sockets = await consumersNsp
          .in(buildConsumerAgentProfileRoom(event.agentId))
          .fetchSockets();
        for (const remote of sockets) {
          clearConsumerSocketAgentAccessSnapshot(remote, event.agentId);
        }
      } catch (error: unknown) {
        logger.warn("consumer_socket_agent_access_snapshot_invalidate_by_agent_failed", {
          agentId: event.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    invalidateUserAccessSnapshot: async (event) => {
      const room = `consumer:principal:user:${event.userId}`;
      try {
        const sockets = await consumersNsp.in(room).fetchSockets();
        for (const remote of sockets) {
          clearAllConsumerSocketAgentAccessSnapshots(remote);
        }
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
