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
}

interface ConsumerSocketEventHandler {
  publish(input: PublishConsumerSocketEventInput): Promise<PublishConsumerSocketEventResult>;
}

let handler: ConsumerSocketEventHandler | undefined;
let warnedMissingConsumerSocketEventHandler = false;

export const registerConsumerSocketEventHandler = (
  next: ConsumerSocketEventHandler | undefined,
): void => {
  handler = next;
  if (next !== undefined) {
    warnedMissingConsumerSocketEventHandler = false;
  }
};

export const publishConsumerSocketEvent = async (
  input: PublishConsumerSocketEventInput,
): Promise<PublishConsumerSocketEventResult> => {
  if (!handler) {
    if (!warnedMissingConsumerSocketEventHandler) {
      warnedMissingConsumerSocketEventHandler = true;
      logger.warn("consumer_socket_event_publish_sink_missing", {
        eventName: input.eventName,
        clientId: input.publisher.clientId,
      });
    }
    return { recipients: 0 };
  }
  return handler.publish(input);
};
