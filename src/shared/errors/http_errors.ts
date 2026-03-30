import { AppError } from "./app_error";

// ─── 400 Bad Request ─────────────────────────────────────────────────────────

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(message, { statusCode: 400, code: "BAD_REQUEST", details });

// ─── 401 Unauthorized ────────────────────────────────────────────────────────

export const unauthorized = (message = "Authentication required"): AppError =>
  new AppError(message, { statusCode: 401, code: "UNAUTHORIZED" });

export const invalidToken = (message = "Invalid or expired token"): AppError =>
  new AppError(message, { statusCode: 401, code: "INVALID_TOKEN" });

// ─── 403 Forbidden ───────────────────────────────────────────────────────────

export const forbidden = (
  message = "You do not have permission to perform this action",
): AppError => new AppError(message, { statusCode: 403, code: "FORBIDDEN" });

// ─── 404 Not Found ───────────────────────────────────────────────────────────

export const notFound = (resource: string): AppError =>
  new AppError(`${resource} not found`, { statusCode: 404, code: "NOT_FOUND" });

/** Registration approval token exists but is past `expiresAt`. */
export const registrationTokenExpired = (message: string): AppError =>
  new AppError(message, { statusCode: 410, code: "REGISTRATION_TOKEN_EXPIRED" });

// ─── 409 Conflict ────────────────────────────────────────────────────────────

export const conflict = (message: string): AppError =>
  new AppError(message, { statusCode: 409, code: "CONFLICT" });

// ─── 422 Unprocessable Entity ────────────────────────────────────────────────

export const unprocessable = (message: string, details?: unknown): AppError =>
  new AppError(message, { statusCode: 422, code: "UNPROCESSABLE_ENTITY", details });

// ─── 429 Too Many Requests ───────────────────────────────────────────────────

export const tooManyRequests = (message = "Too many requests, please try again later"): AppError =>
  new AppError(message, { statusCode: 429, code: "TOO_MANY_REQUESTS" });

// ─── 500 Internal Server Error ───────────────────────────────────────────────

export const internalError = (message = "Internal server error", details?: unknown): AppError =>
  new AppError(message, { statusCode: 500, code: "INTERNAL_SERVER_ERROR", details });

// ─── 503 Service Unavailable ─────────────────────────────────────────────────

export const serviceUnavailable = (message = "Service temporarily unavailable"): AppError =>
  new AppError(message, { statusCode: 503, code: "SERVICE_UNAVAILABLE" });

/** 503 with `details.retry_after_ms` for overload / Retry-After style clients. */
export const serviceUnavailableWithRetry = (message: string, retryAfterMs: number): AppError =>
  new AppError(message, {
    statusCode: 503,
    code: "SERVICE_UNAVAILABLE",
    details: { retry_after_ms: Math.max(0, Math.floor(retryAfterMs)) },
  });
