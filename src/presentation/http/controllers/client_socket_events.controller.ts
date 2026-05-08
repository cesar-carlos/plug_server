import { randomUUID } from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer, { MulterError } from "multer";
import { ZodError } from "zod";

import { publishConsumerSocketEvent } from "../../../application/services/consumer_socket_event_sink";
import { env } from "../../../shared/config/env";
import { AppError } from "../../../shared/errors/app_error";
import { badRequest } from "../../../shared/errors/http_errors";
import {
  clientSocketEventPublishBodySchema,
  jsonUtf8ByteLength,
  toSocketEventAttachment,
  type ClientSocketEventPublishInput,
} from "../../../shared/validators/custom_socket_event";
import { getAuthClient } from "../middlewares/auth.middleware";
import { getValidated } from "../middlewares/validate.middleware";
import {
  noteCustomSocketEventPublishAccepted,
  noteCustomSocketEventPublishIdempotentReplay,
  noteCustomSocketEventPublishRejected,
} from "../../../shared/metrics/socket_consumer.metrics";
import {
  buildClientSocketEventPublishFingerprint,
  getClientSocketEventPublishIdempotencyEntry,
  setClientSocketEventPublishIdempotencyEntry,
  type ClientSocketEventPublishIdempotencyResponse,
} from "../services/client_socket_event_idempotency_store";

const payloadTooLarge = (message: string): AppError =>
  new AppError(message, { statusCode: 413, code: "PAYLOAD_TOO_LARGE" });

const idempotencyConflict = (): AppError =>
  new AppError("Idempotency-Key was already used with a different socket event publish body", {
    statusCode: 409,
    code: "IDEMPOTENCY_KEY_CONFLICT",
  });

export const clientSocketEventUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.restSocketEventFileMaxBytes,
    files: env.restSocketEventMaxFiles,
    fieldSize: env.restSocketEventPayloadJsonMaxBytes + 2048,
  },
});

export const wrapClientSocketEventMulterErrors = (handler: RequestHandler): RequestHandler => {
  return (request, response, next) => {
    handler(request, response, (error: unknown) => {
      if (!error) {
        next();
        return;
      }
      if (error instanceof MulterError) {
        if (error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT") {
          next(payloadTooLarge(`socket event upload rejected: ${error.code}`));
          return;
        }
        next(badRequest(`socket event upload rejected: ${error.code}`));
        return;
      }
      next(error as Parameters<NextFunction>[0]);
    });
  };
};

export const normalizeClientSocketEventIdempotencyKey = (request: Request): string | undefined => {
  const raw = request.get("Idempotency-Key");
  if (raw === undefined) {
    return undefined;
  }
  const idempotencyKey = raw.trim();
  if (idempotencyKey === "") {
    throw badRequest("Idempotency-Key header must not be empty");
  }
  if (idempotencyKey.length > 128) {
    throw badRequest("Idempotency-Key header must be at most 128 characters");
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw badRequest(
      "Idempotency-Key header may contain only letters, numbers, dot, colon, underscore or hyphen",
    );
  }
  return idempotencyKey;
};

const getUploadedFiles = (request: Request): Express.Multer.File[] => {
  const files = request.files;
  if (!files) {
    return [];
  }
  if (Array.isArray(files)) {
    return files;
  }
  return Object.values(files).flat();
};

const parseMultipartEventBody = (request: Request): unknown => {
  const eventField = request.body?.event;
  if (typeof eventField !== "string" || eventField.trim() === "") {
    throw badRequest("multipart field 'event' is required");
  }
  try {
    return JSON.parse(eventField) as unknown;
  } catch {
    throw badRequest("multipart field 'event' must contain valid JSON");
  }
};

const parsePublishInput = (request: Request): ClientSocketEventPublishInput => {
  const rawBody = request.is("multipart/form-data")
    ? parseMultipartEventBody(request)
    : request.body;
  const parsed = clientSocketEventPublishBodySchema.parse(rawBody);
  const payloadSize = jsonUtf8ByteLength(parsed.payload);
  if (payloadSize > env.restSocketEventPayloadJsonMaxBytes) {
    throw payloadTooLarge("socket event payload exceeds JSON size limit");
  }

  const files = getUploadedFiles(request);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > env.restSocketEventTotalFilesMaxBytes) {
    throw payloadTooLarge("socket event attachments exceed total size limit");
  }

  return {
    eventName: parsed.eventName,
    payload: parsed.payload,
    ...(parsed.payloadFrameCompression !== undefined
      ? { payloadFrameCompression: parsed.payloadFrameCompression }
      : {}),
    attachments: files.map(toSocketEventAttachment),
  };
};

export const validateClientSocketEventPublishRequest = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  try {
    response.locals.validated = {
      ...(response.locals.validated as Record<string, unknown> | undefined),
      body: parsePublishInput(request),
    };
    next();
  } catch (error: unknown) {
    noteCustomSocketEventPublishRejected();
    if (error instanceof ZodError || error instanceof AppError) {
      next(error);
      return;
    }
    next(error instanceof Error ? error : badRequest("Invalid socket event publish request"));
  }
};

export const publishClientSocketEvent = async (
  request: Request,
  response: Response,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const body = getValidated<ClientSocketEventPublishInput>(response, "body");
  const idempotencyKey = normalizeClientSocketEventIdempotencyKey(request);
  const fingerprint =
    idempotencyKey !== undefined ? buildClientSocketEventPublishFingerprint(body) : undefined;

  if (idempotencyKey !== undefined && fingerprint !== undefined) {
    const existing = getClientSocketEventPublishIdempotencyEntry(authClient.sub, idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        noteCustomSocketEventPublishRejected();
        throw idempotencyConflict();
      }
      noteCustomSocketEventPublishIdempotentReplay();
      response.status(202).json({
        ...existing.response,
        idempotencyKey,
        idempotentReplay: true,
        requestId: response.locals.requestId as string | undefined,
      });
      return;
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
        clientId: authClient.sub,
      },
      payload: body.payload,
      attachments: body.attachments,
      ...(body.payloadFrameCompression !== undefined
        ? { payloadFrameCompression: body.payloadFrameCompression }
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

  const idempotencyResponse: ClientSocketEventPublishIdempotencyResponse = {
    success: true,
    eventId,
    eventName: body.eventName,
    recipients: result.recipients,
  };
  if (idempotencyKey !== undefined && fingerprint !== undefined) {
    setClientSocketEventPublishIdempotencyEntry(authClient.sub, idempotencyKey, {
      fingerprint,
      response: idempotencyResponse,
    });
  }

  response.status(202).json({
    ...idempotencyResponse,
    ...(idempotencyKey !== undefined ? { idempotencyKey, idempotentReplay: false } : {}),
    requestId: response.locals.requestId as string | undefined,
  });
};
