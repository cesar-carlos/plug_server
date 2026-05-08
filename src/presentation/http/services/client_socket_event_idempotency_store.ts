import { createHash } from "node:crypto";

import { env } from "../../../shared/config/env";
import type { ClientSocketEventPublishInput } from "../../../shared/validators/custom_socket_event";

export interface ClientSocketEventPublishIdempotencyResponse {
  readonly success: true;
  readonly eventId: string;
  readonly eventName: string;
  readonly recipients: number;
}

interface ClientSocketEventPublishIdempotencyEntry {
  readonly fingerprint: string;
  readonly response: ClientSocketEventPublishIdempotencyResponse;
  readonly expiresAtMs: number;
}

const entriesByKey = new Map<string, ClientSocketEventPublishIdempotencyEntry>();

const buildStoreKey = (clientId: string, idempotencyKey: string): string =>
  `${clientId}:${idempotencyKey}`;

export const buildClientSocketEventPublishFingerprint = (
  input: ClientSocketEventPublishInput,
): string => {
  const canonical = JSON.stringify({
    eventName: input.eventName,
    payloadFrameCompression: input.payloadFrameCompression ?? null,
    payload: input.payload,
    attachments: input.attachments,
  });
  return createHash("sha256").update(canonical).digest("hex");
};

export const getClientSocketEventPublishIdempotencyEntry = (
  clientId: string,
  idempotencyKey: string,
  nowMs = Date.now(),
): ClientSocketEventPublishIdempotencyEntry | undefined => {
  const storeKey = buildStoreKey(clientId, idempotencyKey);
  const entry = entriesByKey.get(storeKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAtMs <= nowMs) {
    entriesByKey.delete(storeKey);
    return undefined;
  }
  return entry;
};

export const setClientSocketEventPublishIdempotencyEntry = (
  clientId: string,
  idempotencyKey: string,
  entry: Omit<ClientSocketEventPublishIdempotencyEntry, "expiresAtMs">,
  nowMs = Date.now(),
): void => {
  if (env.restSocketEventIdempotencyTtlMs === 0) {
    return;
  }

  pruneClientSocketEventPublishIdempotencyEntries(nowMs);
  while (entriesByKey.size >= env.restSocketEventIdempotencyMaxEntries) {
    const oldestKey = entriesByKey.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      break;
    }
    entriesByKey.delete(oldestKey);
  }

  entriesByKey.set(buildStoreKey(clientId, idempotencyKey), {
    ...entry,
    expiresAtMs: nowMs + env.restSocketEventIdempotencyTtlMs,
  });
};

export const pruneClientSocketEventPublishIdempotencyEntries = (nowMs = Date.now()): number => {
  let removed = 0;
  for (const [key, entry] of entriesByKey.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      entriesByKey.delete(key);
      removed += 1;
    }
  }
  return removed;
};

export const resetClientSocketEventPublishIdempotencyStore = (): void => {
  entriesByKey.clear();
};
