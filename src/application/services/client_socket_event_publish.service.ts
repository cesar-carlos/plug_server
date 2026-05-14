import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { publishConsumerSocketEvent } from "./consumer_socket_event_sink";
import {
  buildClientSocketEventPublishFingerprint,
  getClientSocketEventPublishIdempotencyEntry,
  setClientSocketEventPublishIdempotencyEntry,
  type ClientSocketEventPublishIdempotencyResponse,
  type ClientSocketEventPublishIdempotencyEntry,
} from "./client_socket_event_idempotency_store";
import { getClientSocketEventPublishDistributedIdempotencyStore } from "./client_socket_event_publish_distributed_idempotency";
import { runWithClientSocketEventPublishIdempotencySerialization } from "./client_socket_event_publish_idempotency_serialization";
import { env } from "../../shared/config/env";
import { AppError } from "../../shared/errors/app_error";
import { logger } from "../../shared/utils/logger";
import {
  noteCustomSocketEventPublishAccepted,
  noteCustomSocketEventPublishIdempotentReplay,
  noteCustomSocketEventPublishRejected,
} from "../../shared/metrics/socket_consumer.metrics";
import {
  noteClientSocketEventIdempotencyRedisConflict,
  noteClientSocketEventIdempotencyRedisLockContention,
  noteClientSocketEventIdempotencyRedisLockWaitTimeout,
  noteClientSocketEventIdempotencyRedisReplay,
} from "./client_socket_event_idempotency_redis_metrics.service";
import type { ClientSocketEventPublishInput } from "../../shared/validators/custom_socket_event";
import { jsonUtf8ByteLength } from "../../shared/validators/custom_socket_event";

const payloadTooLarge = (message: string, details: Record<string, unknown>): AppError =>
  new AppError(message, { statusCode: 413, code: "PAYLOAD_TOO_LARGE", details });

/**
 * Enforces the same size/count limits as the REST publish path (JSON payload, inline attachments).
 */
export const assertClientSocketEventPublishInputWithinLimits = (
  body: ClientSocketEventPublishInput,
): void => {
  let payloadSize: number;
  try {
    payloadSize = jsonUtf8ByteLength(body.payload);
  } catch {
    throw new AppError("socket event payload is not JSON-serializable", {
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  }
  if (payloadSize > env.restSocketEventPayloadJsonMaxBytes) {
    throw payloadTooLarge("socket event payload exceeds JSON size limit", {
      maxPayloadUtf8Bytes: env.restSocketEventPayloadJsonMaxBytes,
    });
  }
  if (body.attachments.length > env.restSocketEventMaxFiles) {
    throw payloadTooLarge("socket event attachments exceed max file count", {
      maxFiles: env.restSocketEventMaxFiles,
    });
  }
  const totalBytes = body.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (totalBytes > env.restSocketEventTotalFilesMaxBytes) {
    throw payloadTooLarge("socket event attachments exceed total size limit", {
      maxTotalAttachmentBytes: env.restSocketEventTotalFilesMaxBytes,
    });
  }
  for (const attachment of body.attachments) {
    if (attachment.sizeBytes > env.restSocketEventFileMaxBytes) {
      throw payloadTooLarge("socket event attachment exceeds per-file size limit", {
        maxPerFileBytes: env.restSocketEventFileMaxBytes,
      });
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

const idempotencyBusy = (): AppError =>
  new AppError("Idempotency-Key is currently being processed by another hub replica", {
    statusCode: 503,
    code: "SERVICE_UNAVAILABLE",
    details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface ClientSocketEventPublishOutcome {
  readonly success: true;
  readonly eventId: string;
  readonly eventName: string;
  readonly recipients: number;
  readonly idempotencyKey?: string;
  readonly idempotentReplay: boolean;
}

const replayOutcome = (
  existing: ClientSocketEventPublishIdempotencyEntry,
  idempotencyKey: string,
): ClientSocketEventPublishOutcome => ({
  success: true,
  eventId: existing.response.eventId,
  eventName: existing.response.eventName,
  recipients: existing.response.recipients,
  idempotencyKey,
  idempotentReplay: true,
});

const resolveExistingIdempotencyEntry = (
  existing: ClientSocketEventPublishIdempotencyEntry | undefined,
  fingerprint: string,
  idempotencyKey: string,
  source: "local" | "redis" = "local",
): ClientSocketEventPublishOutcome | undefined => {
  if (!existing) {
    return undefined;
  }
  if (existing.fingerprint !== fingerprint) {
    noteCustomSocketEventPublishRejected();
    if (source === "redis") {
      noteClientSocketEventIdempotencyRedisConflict();
    }
    throw idempotencyConflict();
  }
  noteCustomSocketEventPublishIdempotentReplay();
  if (source === "redis") {
    noteClientSocketEventIdempotencyRedisReplay();
  }
  return replayOutcome(existing, idempotencyKey);
};

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
  if (params.idempotencyKey !== undefined) {
    return runWithClientSocketEventPublishIdempotencySerialization(
      params.clientId,
      params.idempotencyKey,
      () => executeClientSocketEventPublishUnsynchronized(params),
    );
  }
  return executeClientSocketEventPublishUnsynchronized(params);
};

const executeClientSocketEventPublishUnsynchronized = async (params: {
  readonly clientId: string;
  readonly body: ClientSocketEventPublishInput;
  readonly idempotencyKey?: string;
  readonly publishRequestId?: string;
}): Promise<ClientSocketEventPublishOutcome> => {
  const { clientId, body, idempotencyKey, publishRequestId } = params;
  let fingerprint: string | undefined;
  if (idempotencyKey !== undefined) {
    try {
      fingerprint = buildClientSocketEventPublishFingerprint(body);
    } catch (error: unknown) {
      noteCustomSocketEventPublishRejected();
      throw error;
    }
  }

  if (idempotencyKey !== undefined && fingerprint !== undefined) {
    const existing = getClientSocketEventPublishIdempotencyEntry(clientId, idempotencyKey);
    const localReplay = resolveExistingIdempotencyEntry(existing, fingerprint, idempotencyKey);
    if (localReplay !== undefined) {
      return localReplay;
    }
  }

  let distributedIdempotencyStore =
    idempotencyKey !== undefined && fingerprint !== undefined
      ? getClientSocketEventPublishDistributedIdempotencyStore()
      : undefined;
  let distributedLockToken: string | undefined;
  if (
    distributedIdempotencyStore !== undefined &&
    idempotencyKey !== undefined &&
    fingerprint !== undefined
  ) {
    const existing = await distributedIdempotencyStore.getEntry(clientId, idempotencyKey);
    const distributedReplay = resolveExistingIdempotencyEntry(
      existing,
      fingerprint,
      idempotencyKey,
      "redis",
    );
    if (distributedReplay !== undefined) {
      return distributedReplay;
    }

    try {
      distributedLockToken = await distributedIdempotencyStore.acquireLock(
        clientId,
        idempotencyKey,
        env.restSocketEventIdempotencyRedisLockTtlMs,
      );
    } catch (error: unknown) {
      logger.warn("client_socket_event_distributed_idempotency_lock_unavailable_fallback_local", {
        clientId,
        eventName: body.eventName,
        message: error instanceof Error ? error.message : String(error),
      });
      distributedIdempotencyStore = undefined;
    }
    const releaseDistributedLock = async (): Promise<void> => {
      if (distributedIdempotencyStore !== undefined && distributedLockToken !== undefined) {
        await distributedIdempotencyStore.releaseLock(
          clientId,
          idempotencyKey,
          distributedLockToken,
        );
        distributedLockToken = undefined;
      }
    };
    if (distributedLockToken === undefined) {
      if (distributedIdempotencyStore !== undefined) {
        noteClientSocketEventIdempotencyRedisLockContention();
        const deadlineMs = Date.now() + env.restSocketEventIdempotencyRedisWaitMs;
        while (Date.now() < deadlineMs) {
          await sleep(Math.min(50, Math.max(1, deadlineMs - Date.now())));
          const waitedEntry = await distributedIdempotencyStore.getEntry(clientId, idempotencyKey);
          const waitedReplay = resolveExistingIdempotencyEntry(
            waitedEntry,
            fingerprint,
            idempotencyKey,
            "redis",
          );
          if (waitedReplay !== undefined) {
            return waitedReplay;
          }
        }
        noteClientSocketEventIdempotencyRedisLockWaitTimeout();
        noteCustomSocketEventPublishRejected();
        throw idempotencyBusy();
      }
    }

    if (distributedIdempotencyStore !== undefined) {
      try {
        const existingAfterLock = await distributedIdempotencyStore.getEntry(
          clientId,
          idempotencyKey,
        );
        const replayAfterLock = resolveExistingIdempotencyEntry(
          existingAfterLock,
          fingerprint,
          idempotencyKey,
          "redis",
        );
        if (replayAfterLock !== undefined) {
          await releaseDistributedLock();
          return replayAfterLock;
        }
      } catch (error: unknown) {
        await releaseDistributedLock();
        throw error;
      }
    }
  }

  const eventId = randomUUID();
  const emittedAt = new Date().toISOString();

  try {
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
      if (distributedIdempotencyStore !== undefined) {
        try {
          await distributedIdempotencyStore.setEntry(clientId, idempotencyKey, {
            fingerprint,
            response: idempotencyResponse,
          });
        } catch (error: unknown) {
          logger.warn("client_socket_event_distributed_idempotency_set_failed_after_emit", {
            clientId,
            eventId,
            eventName: body.eventName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return {
      success: true,
      eventId,
      eventName: body.eventName,
      recipients: result.recipients,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      idempotentReplay: false,
    };
  } finally {
    if (
      distributedIdempotencyStore !== undefined &&
      idempotencyKey !== undefined &&
      distributedLockToken !== undefined
    ) {
      await distributedIdempotencyStore.releaseLock(clientId, idempotencyKey, distributedLockToken);
    }
  }
};
