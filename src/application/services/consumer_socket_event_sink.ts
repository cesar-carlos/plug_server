import type {
  ClientSocketEventAttachment,
  PayloadFrameCompression,
} from "../../shared/validators/custom_socket_event";
import { logger } from "../../shared/utils/logger";

export interface PublishConsumerSocketEventInput {
  readonly eventId: string;
  readonly eventName: string;
  readonly emittedAt: string;
  readonly publisher: {
    readonly principalType: "client";
    readonly clientId: string;
  };
  readonly payload: unknown;
  readonly attachments: readonly ClientSocketEventAttachment[];
  readonly payloadFrameCompression?: PayloadFrameCompression;
  /** When set, used as PayloadFrame `requestId` for tracing (e.g. `socket:event.publish` `requestId`). */
  readonly publishRequestId?: string;
}

export interface PublishConsumerSocketEventResult {
  readonly recipients: number;
  readonly recipientCountBestEffort?: boolean;
  /**
   * Local recipient principal ids (e.g. consumer Client `JWT sub`) when the
   * caller resolved them — used as keys into per-recipient durable backlog
   * (`agent_event_stream`). Undefined when not resolved (default fan-out path
   * doesn't compute this); empty array means resolved-but-zero.
   */
  readonly recipientPrincipalIds?: ReadonlyArray<string>;
}

export interface ConsumerSocketEventHandler {
  publish(input: PublishConsumerSocketEventInput): Promise<PublishConsumerSocketEventResult>;
}

type ConsumerSocketEventHandlerDisposer = () => void;

const handlers = new Set<ConsumerSocketEventHandler>();
let warnedMissingConsumerSocketEventHandler = false;

export const registerConsumerSocketEventHandler = (
  next: ConsumerSocketEventHandler,
): ConsumerSocketEventHandlerDisposer => {
  handlers.add(next);
  warnedMissingConsumerSocketEventHandler = false;
  return () => {
    handlers.delete(next);
  };
};

export const publishConsumerSocketEvent = async (
  input: PublishConsumerSocketEventInput,
): Promise<PublishConsumerSocketEventResult> => {
  if (handlers.size === 0) {
    if (!warnedMissingConsumerSocketEventHandler) {
      warnedMissingConsumerSocketEventHandler = true;
      logger.warn("consumer_socket_event_publish_sink_missing", {
        eventName: input.eventName,
        clientId: input.publisher.clientId,
      });
    }
    return { recipients: 0 };
  }
  const results = await Promise.all([...handlers].map((handler) => handler.publish(input)));
  const aggregated: { recipients: number; principalIds?: Set<string> } = {
    recipients: 0,
  };
  for (const result of results) {
    aggregated.recipients += result.recipients;
    if (result.recipientPrincipalIds) {
      aggregated.principalIds ??= new Set<string>();
      for (const id of result.recipientPrincipalIds) {
        aggregated.principalIds.add(id);
      }
    }
  }
  return {
    recipients: aggregated.recipients,
    ...(aggregated.principalIds !== undefined
      ? { recipientPrincipalIds: Array.from(aggregated.principalIds) }
      : {}),
  };
};
