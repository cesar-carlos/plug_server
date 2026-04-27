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
import { normalizeZodIssues } from "./validate.middleware";

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
      const built = buildApprovalZodErrorHtml(request, error);
      if (built) {
        response.status(400).type("html").send(built.html);
        return;
      }
    }
    response.status(400).json({
      message: "Validation failed",
      code: "VALIDATION_ERROR",
      issues: normalizeZodIssues(error),
      requestId,
    });
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
      const built = buildApprovalErrorHtml(request, error);
      if (built) {
        response
          .status(built.statusCode)
          .type("html")
          .send(built.html);
        return;
      }
    }

    response.status(error.statusCode).json({
      message: error.message,
      code: error.code,
      ...(shouldExposeDetails && error.details !== undefined ? { details: error.details } : {}),
      requestId,
    });
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
    const built = buildApprovalInternalErrorHtml(request);
    if (built) {
      response.status(500).type("html").send(built.html);
      return;
    }
  }

  response.status(500).json({
    message: env.nodeEnv === "production" ? "Internal server error" : "Unhandled server error",
    code: "INTERNAL_SERVER_ERROR",
    requestId,
  });
};
