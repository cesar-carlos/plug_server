import { env } from "../../../shared/config/env";

export type RelayIdempotencyEntry = {
  readonly requestId: string;
  expiresAtMs: number;
  responseFrame?: unknown;
};

const relayIdempotencyByConversation = new Map<string, Map<string, RelayIdempotencyEntry>>();

/** Removes expired client-request entries; also invoked by the periodic cleanup timer. */
export const pruneExpiredRelayIdempotencyEntries = (): void => {
  const nowMs = Date.now();
  for (const [conversationId, entries] of relayIdempotencyByConversation.entries()) {
    const expiredClientIds: string[] = [];
    for (const [clientRequestId, item] of entries.entries()) {
      if (item.expiresAtMs <= nowMs) {
        expiredClientIds.push(clientRequestId);
      }
    }
    for (const clientRequestId of expiredClientIds) {
      entries.delete(clientRequestId);
    }
    if (entries.size === 0) {
      relayIdempotencyByConversation.delete(conversationId);
    }
  }
};

let idempotencyCleanupTimer: NodeJS.Timeout | null = null;

export const scheduleRelayIdempotencyCleanupTimer = (): void => {
  if (idempotencyCleanupTimer) {
    return;
  }

  idempotencyCleanupTimer = setInterval(
    pruneExpiredRelayIdempotencyEntries,
    env.socketRelayIdempotencyCleanupIntervalMs,
  );
  idempotencyCleanupTimer.unref?.();
};

export const stopRelayIdempotencyCleanupTimer = (): void => {
  if (!idempotencyCleanupTimer) {
    return;
  }
  clearInterval(idempotencyCleanupTimer);
  idempotencyCleanupTimer = null;
};

export const getOrCreateRelayIdempotencyMap = (conversationId: string): Map<string, RelayIdempotencyEntry> => {
  const existing = relayIdempotencyByConversation.get(conversationId);
  if (existing) {
    return existing;
  }

  const created = new Map<string, RelayIdempotencyEntry>();
  relayIdempotencyByConversation.set(conversationId, created);
  return created;
};

export const getRelayIdempotencyMap = (
  conversationId: string,
): Map<string, RelayIdempotencyEntry> | undefined => relayIdempotencyByConversation.get(conversationId);

export const clearRelayIdempotencyForConversation = (conversationId: string): void => {
  const idempotencyMap = relayIdempotencyByConversation.get(conversationId);
  if (idempotencyMap) {
    idempotencyMap.clear();
    relayIdempotencyByConversation.delete(conversationId);
  }
};

export const resetRelayIdempotencyStore = (): void => {
  relayIdempotencyByConversation.clear();
};
