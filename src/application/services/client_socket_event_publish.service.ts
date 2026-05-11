import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { publishConsumerSocketEvent } from "./consumer_socket_event_sink";
import {
  buildClientSocketEventPublishFingerprint,
  getClientSocketEventPublishIdempotencyEntry,
  setClientSocketEventPublishIdempotencyEntry,
  type ClientSocketEventPublishIdempotencyResponse,
} from "./client_socket_event_idempotency_store";
import { env } from "../../shared/config/env";
import { AppError } from "../../shared/errors/app_error";
import { logger } from "../../shared/utils/logger";
import {
  noteCustomSocketEventPublishAccepted,
  noteCustomSocketEventPublishIdempotentReplay,
  noteCustomSocketEventPublishRejected,
} from "../../shared/metrics/socket_consumer.metrics";
import type { ClientSocketEventPublishInput } from "../../shared/validators/custom_socket_event";
import { jsonUtf8ByteLength } from "../../shared/validators/custom_socket_event";

const payloadTooLarge = (message: string): AppError =>
  new AppError(message, { statusCode: 413, code: "PAYLOAD_TOO_LARGE" });

/**
 * Enforces the same size/count limits as the REST publish path (JSON payload, inline attachments).
 */
export const assertClientSocketEventPublishInputWithinLimits = (
  body: ClientSocketEventPublishInput,
): void => {
  const payloadSize = jsonUtf8ByteLength(body.payload);
  if (payloadSize > env.restSocketEventPayloadJsonMaxBytes) {
    throw payloadTooLarge("socket event payload exceeds JSON size limit");
  }
  if (body.attachments.length > env.restSocketEventMaxFiles) {
    throw payloadTooLarge("socket event attachments exceed max file count");
  }
  const totalBytes = body.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (totalBytes > env.restSocketEventTotalFilesMaxBytes) {
    throw payloadTooLarge("socket event attachments exceed total size limit");
  }
  for (const attachment of body.attachments) {
    if (attachment.sizeBytes > env.restSocketEventFileMaxBytes) {
      throw payloadTooLarge("socket event attachment exceeds per-file size limit");
    }
    const decoded = Buffer.from(attachment.base64, "base64");
    if (decoded.length !== attachment.sizeBytes) {
      throw new AppError("attachment base64 length does not match sizeBytes", {
        statusCode: 400,
        code: "VALIDATION_ERROR",
      });
    }
  }
};

const idempotencyConflict = (): AppError =>
  new AppError("Idempotency-Key was already used with a different socket event publish body", {
    statusCode: 409,
    code: "IDEMPOTENCY_KEY_CONFLICT",
  });

export interface ClientSocketEventPublishOutcome {
  readonly success: true;
  readonly eventId: string;
  readonly eventName: string;
  readonly recipients: number;
  readonly idempotencyKey?: string;
  readonly idempotentReplay: boolean;
}

/**
 * Shared publish path for `client:custom.*` used by REST and `socket:event.publish`.
 * Applies idempotency (when `idempotencyKey` set), emits via {@link publishConsumerSocketEvent}, and records metrics.
 */
export const executeClientSocketEventPublish = async (params: {
  readonly clientId: string;
  readonly body: ClientSocketEventPublishInput;
  readonly idempotencyKey?: string;
  /** Correlates with client `requestId` / HTTP request id in logs and PayloadFrame when set. */
  readonly publishRequestId?: string;
}): Promise<ClientSocketEventPublishOutcome> => {
  const { clientId, body, idempotencyKey, publishRequestId } = params;
  const fingerprint =
    idempotencyKey !== undefined ? buildClientSocketEventPublishFingerprint(body) : undefined;

  if (idempotencyKey !== undefined && fingerprint !== undefined) {
    const existing = getClientSocketEventPublishIdempotencyEntry(clientId, idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        noteCustomSocketEventPublishRejected();
        throw idempotencyConflict();
      }
      noteCustomSocketEventPublishIdempotentReplay();
      return {
        success: true,
        eventId: existing.response.eventId,
        eventName: existing.response.eventName,
        recipients: existing.response.recipients,
        idempotencyKey,
        idempotentReplay: true,
      };
    }
  }

  const eventId = randomUUID();
  const emittedAt = new Date().toISOString();

  let result: Awaited<ReturnType<typeof publishConsumerSocketEvent>>;
  try {
    result = await publishConsumerSocketEvent({
      eventId,
      eventName: body.eventName,
      emittedAt,
      publisher: {
        principalType: "client",
        clientId,
      },
      payload: body.payload,
      attachments: body.attachments,
      ...(body.payloadFrameCompression !== undefined
        ? { payloadFrameCompression: body.payloadFrameCompression }
        : {}),
      ...(publishRequestId !== undefined && publishRequestId.trim() !== ""
        ? { publishRequestId: publishRequestId.trim() }
        : {}),
    });
  } catch (error: unknown) {
    noteCustomSocketEventPublishRejected();
    throw error;
  }

  noteCustomSocketEventPublishAccepted({
    recipients: result.recipients,
    attachmentBytes: body.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
  });

  logger.debug("client_socket_custom_event_published", {
    clientId,
    eventId,
    eventName: body.eventName,
    recipients: result.recipients,
    ...(publishRequestId !== undefined && publishRequestId.trim() !== ""
      ? { publishRequestId: publishRequestId.trim() }
      : {}),
  });

  const idempotencyResponse: ClientSocketEventPublishIdempotencyResponse = {
    success: true,
    eventId,
    eventName: body.eventName,
    recipients: result.recipients,
  };
  if (idempotencyKey !== undefined && fingerprint !== undefined) {
    setClientSocketEventPublishIdempotencyEntry(clientId, idempotencyKey, {
      fingerprint,
      response: idempotencyResponse,
    });
  }

  return {
    success: true,
    eventId,
    eventName: body.eventName,
    recipients: result.recipients,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    idempotentReplay: false,
  };
};
