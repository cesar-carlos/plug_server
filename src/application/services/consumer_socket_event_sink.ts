import type {
  ClientSocketEventAttachment,
  PayloadFrameCompression,
} from "../../shared/validators/custom_socket_event";

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
}

export interface PublishConsumerSocketEventResult {
  readonly recipients: number;
}

interface ConsumerSocketEventHandler {
  publish(input: PublishConsumerSocketEventInput): Promise<PublishConsumerSocketEventResult>;
}

let handler: ConsumerSocketEventHandler | undefined;

export const registerConsumerSocketEventHandler = (
  next: ConsumerSocketEventHandler | undefined,
): void => {
  handler = next;
};

export const publishConsumerSocketEvent = async (
  input: PublishConsumerSocketEventInput,
): Promise<PublishConsumerSocketEventResult> => {
  if (!handler) {
    return { recipients: 0 };
  }
  return handler.publish(input);
};
