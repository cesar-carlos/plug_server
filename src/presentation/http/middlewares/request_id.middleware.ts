import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Inbound `x-request-id` header is only echoed back when it matches this regex. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

const sanitizeInboundRequestId = (rawHeader: string | undefined): string | null => {
  if (!rawHeader) {
    return null;
  }
  const trimmed = rawHeader.trim();
  if (trimmed === "" || !SAFE_REQUEST_ID.test(trimmed)) {
    return null;
  }
  return trimmed;
};

/**
 * Assigns a server-side request id to every request and exposes it on
 * `response.locals.requestId` and the `x-request-id` response header.
 *
 * Any client-supplied `x-request-id` is accepted only when it matches a
 * conservative ASCII pattern (alphanumerics + `._-`, max 128 chars). Anything
 * else is replaced by a freshly generated UUID v4 to avoid:
 *   - log injection (newlines/control chars)
 *   - header-splitting attacks
 *   - oversized strings being copied across logs and downstream systems.
 */
export const requestIdMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const inbound = sanitizeInboundRequestId(request.header("x-request-id"));
  const requestId = inbound ?? randomUUID();

  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);

  next();
};
