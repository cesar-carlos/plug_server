import type { Namespace } from "socket.io";

import type { ConsumerSocketEventHandler } from "../../../application/services/consumer_socket_event_sink";
import { env } from "../../../shared/config/env";
import { AppError } from "../../../shared/errors/app_error";
import {
  noteCustomSocketEventPublishFetchSocketsDedupe,
  noteCustomSocketEventPublishRecipientCapUnverified,
  noteCustomSocketEventPublishRecipientCountBestEffort,
} from "../../../shared/metrics/socket_consumer.metrics";
import { logger } from "../../../shared/utils/logger";
import {
  encodePayloadFrameBridge,
  payloadFrameEncodeOptionsFromPreference,
} from "../../../shared/utils/payload_frame";
import { buildCustomSocketEventRoom } from "./custom_events/custom_socket_event_rooms";
import {
  enforceCustomEventDistributedCountCircuit,
  type DistributedCountCircuitState,
} from "./custom_events/custom_socket_event_distributed_count_circuit";
import { shouldSkipCustomSocketEventZeroRecipientEarlyReturn } from "./custom_events/custom_socket_event_room_recipient_count";

type RoomRemoteSocket = Awaited<ReturnType<Namespace["fetchSockets"]>>[number];

export interface RoomRecipientCount {
  readonly recipients: number;
  readonly recipientCountBestEffort: boolean;
  readonly recipientCountLocalOnly: boolean;
  readonly fetchedSockets?: ReadonlyArray<RoomRemoteSocket>;
}

export interface ConsumerSocketPublishHandlerDeps {
  readonly consumersNsp: Namespace;
  readonly customEventDistributedCountCircuit: DistributedCountCircuitState;
  readonly countSocketsInRoom: (
    namespace: Namespace,
    room: string,
    options?: { readonly captureSockets?: boolean },
  ) => Promise<RoomRecipientCount>;
}

/**
 * Builds the `ConsumerSocketEventHandler` whose `publish` callback fans out
 * a custom socket event to every consumer joined to the event's room. The
 * handler enforces local and cluster-wide recipient caps, optionally
 * resolves recipient principal ids (when the durable agent-event stream is
 * active) and encodes the broadcast `PayloadFrame`.
 */
export const buildConsumerSocketPublishHandler = (
  deps: ConsumerSocketPublishHandlerDeps,
): ConsumerSocketEventHandler => {
  const { consumersNsp, customEventDistributedCountCircuit, countSocketsInRoom } = deps;

  return {
    publish: async (event) => {
      const room = buildCustomSocketEventRoom(event.eventName);
      enforceCustomEventDistributedCountCircuit(
        customEventDistributedCountCircuit,
        event.eventName,
      );
      const recipientCount = await countSocketsInRoom(consumersNsp, room, {
        captureSockets: env.agentEventStreamEnabled,
      });
      if (
        !recipientCount.recipientCountBestEffort &&
        !shouldSkipCustomSocketEventZeroRecipientEarlyReturn(recipientCount) &&
        recipientCount.recipients === 0
      ) {
        return { recipients: 0 };
      }
      if (
        !recipientCount.recipientCountBestEffort &&
        env.restSocketEventMaxRecipients > 0 &&
        recipientCount.recipients > env.restSocketEventMaxRecipients
      ) {
        throw new AppError("socket event recipient fan-out limit exceeded", {
          statusCode: 503,
          code: "SERVICE_UNAVAILABLE",
          details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
        });
      }
      if (recipientCount.recipientCountBestEffort) {
        enforceCustomEventDistributedCountCircuit(
          customEventDistributedCountCircuit,
          event.eventName,
        );
        if (
          env.restSocketEventBestEffortLocalMaxRecipients > 0 &&
          recipientCount.recipients > env.restSocketEventBestEffortLocalMaxRecipients
        ) {
          logger.warn("socket_custom_event_publish_best_effort_local_cap_exceeded", {
            eventName: event.eventName,
            localRecipients: recipientCount.recipients,
            localCap: env.restSocketEventBestEffortLocalMaxRecipients,
          });
          throw new AppError("socket event recipient fan-out limit exceeded", {
            statusCode: 503,
            code: "SERVICE_UNAVAILABLE",
            details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
          });
        }
        noteCustomSocketEventPublishRecipientCountBestEffort();
        noteCustomSocketEventPublishRecipientCapUnverified();
        logger.warn("socket_custom_event_publish_recipient_count_best_effort", {
          eventName: event.eventName,
          localRecipients: recipientCount.recipients,
        });
      }
      let frame;
      try {
        frame = await encodePayloadFrameBridge(
          {
            eventId: event.eventId,
            eventName: event.eventName,
            emittedAt: event.emittedAt,
            publisher: event.publisher,
            payload: event.payload,
            attachments: event.attachments,
          },
          {
            ...payloadFrameEncodeOptionsFromPreference(event.payloadFrameCompression),
            requestId:
              typeof event.publishRequestId === "string" && event.publishRequestId.trim() !== ""
                ? event.publishRequestId.trim()
                : event.eventId,
            omitTraceId: true,
          },
        );
      } catch {
        throw new AppError("Failed to encode custom socket event PayloadFrame", {
          statusCode: 503,
          code: "SERVICE_UNAVAILABLE",
          details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
        });
      }
      /**
       * When the durable agent-event stream is active, resolve the local
       * recipient principal ids (consumer Client `sub`) BEFORE the emit so
       * the publish caller can append the frame to each recipient's backlog
       * stream. `fetchSockets` is a cluster-wide RPC; we only do it when
       * streams are enabled (default off) to avoid extra round-trips on
       * the hot publish path.
       */
      let recipientPrincipalIds: string[] | undefined;
      if (env.agentEventStreamEnabled) {
        try {
          let principalSockets: ReadonlyArray<{ readonly data: unknown }>;
          if (recipientCount.fetchedSockets !== undefined) {
            principalSockets = recipientCount.fetchedSockets;
            noteCustomSocketEventPublishFetchSocketsDedupe();
          } else {
            principalSockets = await consumersNsp.in(room).fetchSockets();
          }
          const ids = new Set<string>();
          for (const recipient of principalSockets) {
            const principalSub = (recipient.data as { user?: { sub?: unknown } })?.user?.sub;
            if (typeof principalSub === "string" && principalSub.trim() !== "") {
              ids.add(principalSub.trim());
            }
          }
          recipientPrincipalIds = Array.from(ids);
        } catch (error: unknown) {
          logger.warn("custom_socket_event_recipient_principal_resolution_failed", {
            eventName: event.eventName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      consumersNsp.to(room).emit(event.eventName, frame);
      return {
        recipients: recipientCount.recipients,
        ...(recipientCount.recipientCountBestEffort ? { recipientCountBestEffort: true } : {}),
        ...(recipientPrincipalIds !== undefined ? { recipientPrincipalIds } : {}),
      };
    },
  };
};
