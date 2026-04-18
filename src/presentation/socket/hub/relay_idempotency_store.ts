import { env } from "../../../shared/config/env";

export type RelayIdempotencyEntry = {
  readonly requestId: string;
  expiresAtMs: number;
  responseFrame?: unknown;
  /**
   * Consumer socket ids of duplicate requests that arrived while the original was
   * still in flight (no `responseFrame` yet). When the response is finally stored,
   * the bridge replays it to each of these waiters via `relay:rpc.response`.
   */
  pendingReplayConsumerSocketIds?: string[];
};

interface RelayIdempotencyMetricsCounters {
  evictedPerConversationCap: number;
  evictedGlobalCap: number;
  prunedExpired: number;
}

const relayIdempotencyByConversation = new Map<string, Map<string, RelayIdempotencyEntry>>();
let totalEntries = 0;

const relayIdempotencyMetrics: RelayIdempotencyMetricsCounters = {
  evictedPerConversationCap: 0,
  evictedGlobalCap: 0,
  prunedExpired: 0,
};

/**
 * Drops the FIFO-oldest entry across the entire store. Map preserves
 * insertion order so the first key in the first conversation map is the
 * globally oldest. Used to enforce `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES`.
 */
const evictGlobalOldest = (): boolean => {
  for (const [conversationId, entries] of relayIdempotencyByConversation) {
    const it = entries.keys().next();
    if (it.done) {
      relayIdempotencyByConversation.delete(conversationId);
      continue;
    }
    entries.delete(it.value);
    totalEntries -= 1;
    if (entries.size === 0) {
      relayIdempotencyByConversation.delete(conversationId);
    }
    return true;
  }
  return false;
};

/** Removes expired client-request entries; also invoked by the periodic cleanup timer. */
export const pruneExpiredRelayIdempotencyEntries = (): void => {
  const nowMs = Date.now();
  let pruned = 0;
  for (const [conversationId, entries] of relayIdempotencyByConversation.entries()) {
    const expiredClientIds: string[] = [];
    for (const [clientRequestId, item] of entries.entries()) {
      if (item.expiresAtMs <= nowMs) {
        expiredClientIds.push(clientRequestId);
      }
    }
    for (const clientRequestId of expiredClientIds) {
      entries.delete(clientRequestId);
      totalEntries -= 1;
      pruned += 1;
    }
    if (entries.size === 0) {
      relayIdempotencyByConversation.delete(conversationId);
    }
  }
  if (pruned > 0) {
    relayIdempotencyMetrics.prunedExpired += pruned;
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

export const getOrCreateRelayIdempotencyMap = (
  conversationId: string,
): Map<string, RelayIdempotencyEntry> => {
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
): Map<string, RelayIdempotencyEntry> | undefined =>
  relayIdempotencyByConversation.get(conversationId);

/**
 * Stores or updates an idempotency entry while enforcing per-conversation and
 * global caps. New entries beyond `SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION`
 * cause the FIFO-oldest entry of the same conversation to be evicted; entries
 * beyond `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES` cause the FIFO-oldest
 * entry across the whole store to be evicted. Updates to existing keys do not
 * count against the caps.
 */
export const setRelayIdempotencyEntry = (
  conversationId: string,
  clientRequestId: string,
  entry: RelayIdempotencyEntry,
): void => {
  const conversationMap = getOrCreateRelayIdempotencyMap(conversationId);
  const isUpdate = conversationMap.has(clientRequestId);

  if (!isUpdate) {
    const perConvCap = env.socketRelayIdempotencyMaxEntriesPerConversation;
    while (conversationMap.size >= perConvCap) {
      const oldest = conversationMap.keys().next();
      if (oldest.done) break;
      conversationMap.delete(oldest.value);
      totalEntries -= 1;
      relayIdempotencyMetrics.evictedPerConversationCap += 1;
    }

    const globalCap = env.socketRelayIdempotencyMaxTotalEntries;
    if (globalCap > 0) {
      while (totalEntries >= globalCap) {
        if (!evictGlobalOldest()) break;
        relayIdempotencyMetrics.evictedGlobalCap += 1;
      }
    }
  }

  conversationMap.set(clientRequestId, entry);
  if (!isUpdate) {
    totalEntries += 1;
  }
};

export const clearRelayIdempotencyForConversation = (conversationId: string): void => {
  const idempotencyMap = relayIdempotencyByConversation.get(conversationId);
  if (idempotencyMap) {
    totalEntries -= idempotencyMap.size;
    if (totalEntries < 0) {
      totalEntries = 0;
    }
    idempotencyMap.clear();
    relayIdempotencyByConversation.delete(conversationId);
  }
};

export const resetRelayIdempotencyStore = (): void => {
  relayIdempotencyByConversation.clear();
  totalEntries = 0;
  relayIdempotencyMetrics.evictedPerConversationCap = 0;
  relayIdempotencyMetrics.evictedGlobalCap = 0;
  relayIdempotencyMetrics.prunedExpired = 0;
};

export interface RelayIdempotencyMetricsSnapshot {
  readonly totalEntries: number;
  readonly conversationCount: number;
  readonly evictedPerConversationCap: number;
  readonly evictedGlobalCap: number;
  readonly prunedExpired: number;
}

export const getRelayIdempotencyMetricsSnapshot = (): RelayIdempotencyMetricsSnapshot => ({
  totalEntries,
  conversationCount: relayIdempotencyByConversation.size,
  evictedPerConversationCap: relayIdempotencyMetrics.evictedPerConversationCap,
  evictedGlobalCap: relayIdempotencyMetrics.evictedGlobalCap,
  prunedExpired: relayIdempotencyMetrics.prunedExpired,
});
