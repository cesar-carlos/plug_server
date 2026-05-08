import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { env } from "../../../shared/config/env";
import { AppError } from "../../../shared/errors/app_error";
import { logger } from "../../../shared/utils/logger";
import {
  buildApprovalErrorHtml,
  buildApprovalInternalErrorHtml,
  buildApprovalZodErrorHtml,
  shouldReturnHtmlForApprovalError,
} from "../helpers/approval_error_html";
import { buildHttpErrorResponseBody } from "../helpers/http_error_response";
import { normalizeZodIssues } from "./validate.middleware";

const clientErrorByStatus: ReadonlyMap<
  number,
  { readonly code: string; readonly message: string }
> = new Map([
  [400, { code: "BAD_REQUEST", message: "Invalid request" }],
  [401, { code: "UNAUTHORIZED", message: "Authentication required" }],
  [403, { code: "FORBIDDEN", message: "Forbidden" }],
  [404, { code: "NOT_FOUND", message: "Resource not found" }],
  [413, { code: "PAYLOAD_TOO_LARGE", message: "Request payload too large" }],
  [415, { code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported media type" }],
  [429, { code: "TOO_MANY_REQUESTS", message: "Too many requests, please try again later." }],
]);

const getClientErrorStatusCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as { readonly status?: unknown; readonly statusCode?: unknown };
  const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500
    ? status
    : undefined;
};

export const errorMiddleware = (
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void => {
  const requestId = response.locals.requestId as string | undefined;
  const shouldExposeDetails = env.nodeEnv !== "production";

  if (error instanceof ZodError) {
    if (shouldReturnHtmlForApprovalError(request) && !response.headersSent) {
      const built = buildApprovalZodErrorHtml(request, error, requestId);
      if (built) {
        response.status(400).type("html").send(built.html);
        return;
      }
    }
    response.status(400).json(
      buildHttpErrorResponseBody({
        message: "Validation failed",
        code: "VALIDATION_ERROR",
        issues: normalizeZodIssues(error),
        requestId,
      }),
    );
    return;
  }

  if (error instanceof AppError) {
    if (
      (error.statusCode === 503 || error.statusCode === 429) &&
      typeof error.details === "object" &&
      error.details !== null &&
      "retry_after_ms" in error.details
    ) {
      const retryAfterMs = (error.details as Record<string, unknown>).retry_after_ms;
      if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
        response.setHeader("Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1000)).toString());
      }
    }

    if (error.statusCode >= 500) {
      logger.error(error.message, { requestId, code: error.code, details: error.details });
    }

    if (shouldReturnHtmlForApprovalError(request) && !response.headersSent) {
      const built = buildApprovalErrorHtml(request, error, requestId);
      if (built) {
        response.status(built.statusCode).type("html").send(built.html);
        return;
      }
    }

    response.status(error.statusCode).json(
      buildHttpErrorResponseBody({
        message: error.message,
        code: error.code,
        details: error.details,
        exposeDetails: shouldExposeDetails,
        requestId,
      }),
    );
    return;
  }

  const clientErrorStatusCode = getClientErrorStatusCode(error);
  if (clientErrorStatusCode !== undefined) {
    const fallback = clientErrorByStatus.get(clientErrorStatusCode) ?? {
      code: "REQUEST_ERROR",
      message: "Request failed",
    };
    response.status(clientErrorStatusCode).json(
      buildHttpErrorResponseBody({
        message: fallback.message,
        code: fallback.code,
        requestId,
      }),
    );
    return;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  logger.error("Unhandled application error", {
    requestId,
    message: err.message,
    stack: err.stack,
    name: err.name,
  });

  if (shouldReturnHtmlForApprovalError(request) && !response.headersSent) {
    const built = buildApprovalInternalErrorHtml(request, requestId);
    if (built) {
      response.status(500).type("html").send(built.html);
      return;
    }
  }

  response.status(500).json(
    buildHttpErrorResponseBody({
      message: env.nodeEnv === "production" ? "Internal server error" : "Unhandled server error",
      code: "INTERNAL_SERVER_ERROR",
      requestId,
    }),
  );
};
