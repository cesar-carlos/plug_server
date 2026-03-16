import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { env } from "../../../shared/config/env";
import { AppError } from "../../../shared/errors/app_error";
import { logger } from "../../../shared/utils/logger";
import { normalizeZodIssues } from "./validate.middleware";

export const errorMiddleware = (
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void => {
  const requestId = response.locals.requestId as string | undefined;
  const shouldExposeDetails = env.nodeEnv !== "production";

  if (error instanceof ZodError) {
    response.status(400).json({
      message: "Validation failed",
      code: "VALIDATION_ERROR",
      issues: normalizeZodIssues(error),
      requestId,
    });
    return;
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      logger.error(error.message, { requestId, code: error.code, details: error.details });
    }

    response.status(error.statusCode).json({
      message: error.message,
      code: error.code,
      ...(shouldExposeDetails && error.details !== undefined ? { details: error.details } : {}),
      requestId,
    });
    return;
  }

  logger.error("Unhandled application error", { requestId, error });

  response.status(500).json({
    message: env.nodeEnv === "production" ? "Internal server error" : "Unhandled server error",
    code: "INTERNAL_SERVER_ERROR",
    requestId,
  });
};
