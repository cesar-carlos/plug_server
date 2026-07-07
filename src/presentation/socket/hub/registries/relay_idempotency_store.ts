import { env } from "../../../../shared/config/env";
import { getRelayRequestRoute } from "./relay_request_registry";
import { sweepRelayTimeoutTombstones } from "../relay/relay_timeout_tombstone";

export type RelayIdempotencyEntry = {
  readonly requestId: string;
  expiresAtMs: number;
  responseFrame?: unknown;
  /**
   * Consumer socket ids of duplicate requests that arrived while the original was
   * still in flight (no `responseFrame` yet). When the response is finally stored,
   * the bridge replays it to each of these waiters via `relay:rpc.response`.
   */
  pendingReplayConsumerSocketIds?: Set<string>;
};

export type SetRelayIdempotencyEntryResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "per_conversation_cap_reached" | "global_cap_reached";
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

const isCompletedIdempotencyEntry = (entry: RelayIdempotencyEntry): boolean =>
  entry.responseFrame !== undefined;

/**
 * Drops the FIFO-oldest entry across the entire store. Map preserves
 * insertion order so the first key in the first conversation map is the
 * globally oldest. Used to enforce `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES`.
 */
const evictGlobalOldestCompleted = (): boolean => {
  for (const [conversationId, entries] of relayIdempotencyByConversation) {
    let evicted = false;
    for (const [clientRequestId, entry] of entries) {
      if (!isCompletedIdempotencyEntry(entry)) {
        continue;
      }
      entries.delete(clientRequestId);
      totalEntries -= 1;
      evicted = true;
      break;
    }
    if (!evicted) {
      if (entries.size === 0) {
        relayIdempotencyByConversation.delete(conversationId);
      }
      continue;
    }
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
      if (isCompletedIdempotencyEntry(item) && item.expiresAtMs <= nowMs) {
        expiredClientIds.push(clientRequestId);
        continue;
      }
      if (
        !isCompletedIdempotencyEntry(item) &&
        item.expiresAtMs <= nowMs &&
        !getRelayRequestRoute(item.requestId)
      ) {
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

  idempotencyCleanupTimer = setInterval(() => {
    pruneExpiredRelayIdempotencyEntries();
    sweepRelayTimeoutTombstones();
  }, env.socketRelayIdempotencyCleanupIntervalMs);
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
 * cause the FIFO-oldest completed entry of the same conversation to be evicted;
 * entries beyond `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES` cause the FIFO-oldest
 * completed entry across the whole store to be evicted. In-flight entries are
 * pinned until completion/removal so deduplication cannot be lost mid-flight.
 * Updates to existing keys do not count against the caps.
 */
export const setRelayIdempotencyEntry = (
  conversationId: string,
  clientRequestId: string,
  entry: RelayIdempotencyEntry,
): SetRelayIdempotencyEntryResult => {
  const conversationMap = getOrCreateRelayIdempotencyMap(conversationId);
  const isUpdate = conversationMap.has(clientRequestId);

  if (!isUpdate) {
    const perConvCap = env.socketRelayIdempotencyMaxEntriesPerConversation;
    while (conversationMap.size >= perConvCap) {
      let evicted = false;
      for (const [existingClientRequestId, existingEntry] of conversationMap) {
        if (!isCompletedIdempotencyEntry(existingEntry)) {
          continue;
        }
        conversationMap.delete(existingClientRequestId);
        totalEntries -= 1;
        evicted = true;
        break;
      }
      if (!evicted) {
        break;
      }
      relayIdempotencyMetrics.evictedPerConversationCap += 1;
    }
    if (conversationMap.size >= perConvCap) {
      return { ok: false, reason: "per_conversation_cap_reached" };
    }

    const globalCap = env.socketRelayIdempotencyMaxTotalEntries;
    if (globalCap > 0) {
      while (totalEntries >= globalCap) {
        if (!evictGlobalOldestCompleted()) break;
        relayIdempotencyMetrics.evictedGlobalCap += 1;
      }
      if (totalEntries >= globalCap) {
        return { ok: false, reason: "global_cap_reached" };
      }
    }
  }

  conversationMap.set(clientRequestId, entry);
  if (!isUpdate) {
    totalEntries += 1;
  }
  return { ok: true };
};

export const removeRelayIdempotencyEntry = (
  conversationId: string,
  clientRequestId: string,
): void => {
  const conversationMap = relayIdempotencyByConversation.get(conversationId);
  if (!conversationMap || !conversationMap.delete(clientRequestId)) {
    return;
  }
  totalEntries = Math.max(0, totalEntries - 1);
  if (conversationMap.size === 0) {
    relayIdempotencyByConversation.delete(conversationId);
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
