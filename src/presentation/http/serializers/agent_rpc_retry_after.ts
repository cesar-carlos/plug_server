/**
 * Extract a `Retry-After` HTTP header value from an agent RPC error payload.
 *
 * Aligned with `socket_communication_standard.md` (`-32013` rate limiting and
 * `client_token.getPolicy` rate limit policy):
 *   - error code `-32013` (`rate_limited`) means the agent applied a rate
 *     limit and may also surface `error.data.retry_after_ms` and
 *     `error.data.reset_at` so callers can back off precisely
 *   - `client_token.getPolicy` specifically uses
 *     `reason: "client_token_get_policy_rate_limited"` with both fields set
 *
 * The HTTP `Retry-After` header is specified in seconds (RFC 9110), so we
 * round up `retry_after_ms`. When only `reset_at` is provided we compute the
 * delta from "now". Returns `null` when no usable hint is available.
 */

import { isRecord } from "../../../shared/utils/rpc_types";
import type { NormalizedAgentRpcResponse } from "./agent_rpc_response.serializer";

const RATE_LIMIT_ERROR_CODE = -32013;

const toFiniteNonNegative = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
};

const retryAfterSecondsFromErrorData = (data: unknown, nowMs: number): number | null => {
  if (!isRecord(data)) {
    return null;
  }

  const retryAfterMs = toFiniteNonNegative(data.retry_after_ms);
  if (retryAfterMs !== null) {
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }

  if (typeof data.reset_at === "string" && data.reset_at.trim() !== "") {
    const resetAtMs = Date.parse(data.reset_at);
    if (Number.isFinite(resetAtMs)) {
      const deltaMs = resetAtMs - nowMs;
      if (deltaMs > 0) {
        return Math.max(1, Math.ceil(deltaMs / 1000));
      }
    }
  }

  return null;
};

const collectErrorsFromNormalizedResponse = (
  normalized: NormalizedAgentRpcResponse,
): readonly { code: number; data?: unknown }[] => {
  if (normalized.type === "single") {
    return normalized.item.error
      ? [{ code: normalized.item.error.code, ...(normalized.item.error.data !== undefined ? { data: normalized.item.error.data } : {}) }]
      : [];
  }
  if (normalized.type === "batch") {
    const errors: { code: number; data?: unknown }[] = [];
    for (const item of normalized.items) {
      if (item.error) {
        errors.push({
          code: item.error.code,
          ...(item.error.data !== undefined ? { data: item.error.data } : {}),
        });
      }
    }
    return errors;
  }
  return [];
};

/**
 * Returns the longest `Retry-After` (in seconds) advised by any rate-limited
 * error in the response, or `null` when no `-32013` carries a usable hint.
 *
 * For batch responses we pick the **maximum** so we don't suggest the client
 * retries earlier than the strictest limit in the batch.
 */
export const resolveAgentRpcRetryAfterSeconds = (
  response: unknown,
  options?: { readonly nowMs?: number },
): number | null => {
  if (!response || typeof response !== "object") {
    return null;
  }

  const normalized = response as NormalizedAgentRpcResponse;
  if (normalized.type !== "single" && normalized.type !== "batch") {
    return null;
  }

  const errors = collectErrorsFromNormalizedResponse(normalized);
  if (errors.length === 0) {
    return null;
  }

  const nowMs = options?.nowMs ?? Date.now();
  let maxRetryAfter: number | null = null;
  for (const err of errors) {
    if (err.code !== RATE_LIMIT_ERROR_CODE) {
      continue;
    }
    const seconds = retryAfterSecondsFromErrorData(err.data, nowMs);
    if (seconds !== null) {
      maxRetryAfter = maxRetryAfter === null ? seconds : Math.max(maxRetryAfter, seconds);
    }
  }
  return maxRetryAfter;
};
