import { isRecord } from "./rpc_types";

const toPositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.ceil(value);
};

const readRetryAfterMsFromErrorLike = (value: unknown): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const directMs = toPositiveInteger(value.retryAfterMs);
  if (directMs !== undefined) {
    return directMs;
  }

  const details = isRecord(value.details) ? value.details : null;
  const detailsMs = details ? toPositiveInteger(details.retry_after_ms) : undefined;
  if (detailsMs !== undefined) {
    return detailsMs;
  }

  const data = isRecord(value.data) ? value.data : null;
  return data ? toPositiveInteger(data.retry_after_ms) : undefined;
};

/**
 * Client-side retry helper for Socket bridge responses. It understands all
 * public retry hints emitted by the hub:
 * - Socket envelope errors: `error.retryAfterMs`
 * - JSON-RPC agent errors: `error.data.retry_after_ms`
 * - Legacy `agents:command_response`: top-level `retryAfterSeconds`
 */
export const resolveSocketRetryAfterMs = (payload: unknown): number | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelopeErrorMs = readRetryAfterMsFromErrorLike(payload.error);
  if (envelopeErrorMs !== undefined) {
    return envelopeErrorMs;
  }

  const topLevelSeconds = toPositiveInteger(payload.retryAfterSeconds);
  if (topLevelSeconds !== undefined) {
    return topLevelSeconds * 1000;
  }

  const response = isRecord(payload.response) ? payload.response : null;
  const item = response && isRecord(response.item) ? response.item : null;
  const itemErrorMs = item ? readRetryAfterMsFromErrorLike(item.error) : undefined;
  if (itemErrorMs !== undefined) {
    return itemErrorMs;
  }

  const responseErrorMs = response ? readRetryAfterMsFromErrorLike(response.error) : undefined;
  if (responseErrorMs !== undefined) {
    return responseErrorMs;
  }

  const items = response && Array.isArray(response.items) ? response.items : [];
  const retryHints = items
    .map((entry) => (isRecord(entry) ? readRetryAfterMsFromErrorLike(entry.error) : undefined))
    .filter((value): value is number => value !== undefined);
  if (retryHints.length === 0) {
    return undefined;
  }
  return Math.max(...retryHints);
};
