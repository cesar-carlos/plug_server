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

export const agentNotFound = (agentId: string): AppError =>
  new AppError(`Agent ${agentId} not found`, { statusCode: 404, code: "AGENT_NOT_FOUND" });

/** Registration approval token exists but is past `expiresAt`. */
export const registrationTokenExpired = (message: string): AppError =>
  new AppError(message, { statusCode: 410, code: "REGISTRATION_TOKEN_EXPIRED" });

// ─── 409 Conflict ────────────────────────────────────────────────────────────

export const conflict = (message: string): AppError =>
  new AppError(message, { statusCode: 409, code: "CONFLICT" });

export const agentAlreadyLinked = (agentId: string): AppError =>
  new AppError(`Agent ${agentId} is already linked to another user`, {
    statusCode: 409,
    code: "AGENT_ALREADY_LINKED",
  });

export const agentInactive = (agentId: string): AppError =>
  new AppError(`Agent ${agentId} is inactive and cannot be used`, {
    statusCode: 403,
    code: "AGENT_INACTIVE",
  });

export const agentAccessDenied = (agentId: string): AppError =>
  new AppError(`You do not have access to agent ${agentId}`, {
    statusCode: 403,
    code: "AGENT_ACCESS_DENIED",
  });

export type AgentNotOnlineReason = "offline" | "different_account";

/** Agent is not usable for self-bind: offline, or online under another user (details.reason). */
export const agentNotOnlineForUser = (
  agentId: string,
  reason: AgentNotOnlineReason,
): AppError => {
  const message =
    reason === "offline"
      ? `Agent ${agentId} is not connected right now`
      : `Agent ${agentId} is connected under a different account`;
  return new AppError(message, {
    statusCode: 422,
    code: "AGENT_NOT_ONLINE_FOR_USER",
    details: { reason },
  });
};

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
