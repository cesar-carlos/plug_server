import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer, { MulterError } from "multer";
import { ZodError } from "zod";

import {
  assertClientSocketEventPublishInputWithinLimits,
  executeClientSocketEventPublish,
} from "../../../application/services/client_socket_event_publish.service";
import { env } from "../../../shared/config/env";
import { AppError } from "../../../shared/errors/app_error";
import { badRequest } from "../../../shared/errors/http_errors";
import {
  clientSocketEventPublishBodySchema,
  toSocketEventAttachment,
  type ClientSocketEventPublishInput,
} from "../../../shared/validators/custom_socket_event";
import { getAuthClient } from "../middlewares/auth.middleware";
import { getValidated } from "../middlewares/validate.middleware";
import { noteCustomSocketEventPublishRejected } from "../../../shared/metrics/socket_consumer.metrics";

const payloadTooLarge = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError(message, { statusCode: 413, code: "PAYLOAD_TOO_LARGE", details });

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
          next(
            payloadTooLarge(`socket event upload rejected: ${error.code}`, {
              multerCode: error.code,
              maxFileBytes: env.restSocketEventFileMaxBytes,
              maxFiles: env.restSocketEventMaxFiles,
            }),
          );
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
  const files = getUploadedFiles(request);
  const body: ClientSocketEventPublishInput = {
    eventName: parsed.eventName,
    payload: parsed.payload,
    ...(parsed.payloadFrameCompression !== undefined
      ? { payloadFrameCompression: parsed.payloadFrameCompression }
      : {}),
    attachments: files.map(toSocketEventAttachment),
  };
  assertClientSocketEventPublishInputWithinLimits(body);
  return body;
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

  const httpRequestId = response.locals.requestId;
  const outcome = await executeClientSocketEventPublish({
    clientId: authClient.sub,
    body,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(typeof httpRequestId === "string" && httpRequestId.trim() !== ""
      ? { publishRequestId: httpRequestId.trim() }
      : {}),
  });

  response.status(202).json({
    success: outcome.success,
    eventId: outcome.eventId,
    eventName: outcome.eventName,
    recipients: outcome.recipients,
    ...(outcome.idempotencyKey !== undefined
      ? { idempotencyKey: outcome.idempotencyKey, idempotentReplay: outcome.idempotentReplay }
      : {}),
    requestId: response.locals.requestId as string | undefined,
  });
};
