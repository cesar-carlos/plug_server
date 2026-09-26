/**
 * Negative cache for automatic PayloadFrame gzip.
 *
 * Keyed only by event name and a coarse size tier (log2). It never stores
 * payload bytes. Explicit `always_gzip` does not consult or update this cache.
 * Matches plug_agente `AdaptiveCompressionCache` (64 entries, 30s TTL).
 */

const ADAPTIVE_COMPRESSION_SKIP_TTL_MS = 30_000;
const ADAPTIVE_COMPRESSION_CACHE_MAX_ENTRIES = 64;
const DEFAULT_EVENT_NAME = "frame";

const incompressibleUntil = new Map<string, number>();

const sizeTier = (originalSize: number): number => {
  let tier = 0;
  let value = originalSize < 1 ? 1 : originalSize;
  while (value > 1) {
    value >>= 1;
    tier += 1;
  }
  return tier;
};

const cacheKey = (eventName: string | undefined, originalSize: number): string => {
  const event = eventName === undefined || eventName.trim() === "" ? DEFAULT_EVENT_NAME : eventName;
  return `${event}:${sizeTier(originalSize)}`;
};

const touch = (key: string, until: number): void => {
  incompressibleUntil.delete(key);
  incompressibleUntil.set(key, until);
  while (incompressibleUntil.size > ADAPTIVE_COMPRESSION_CACHE_MAX_ENTRIES) {
    const oldest = incompressibleUntil.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    incompressibleUntil.delete(oldest);
  }
};

/** True when auto gzip should be skipped for this event and size tier. */
export const shouldSkipAutoGzip = (
  eventName: string | undefined,
  originalSize: number,
  nowMs: number = Date.now(),
): boolean => {
  const key = cacheKey(eventName, originalSize);
  const until = incompressibleUntil.get(key);
  if (until === undefined || until <= nowMs) {
    if (until !== undefined) {
      incompressibleUntil.delete(key);
    }
    return false;
  }
  touch(key, until);
  return true;
};

/** Remember whether auto gzip actually shrank this event and size tier. */
export const recordAutoGzipAttempt = (
  eventName: string | undefined,
  originalSize: number,
  reduced: boolean,
  nowMs: number = Date.now(),
): void => {
  const key = cacheKey(eventName, originalSize);
  if (reduced) {
    incompressibleUntil.delete(key);
    return;
  }
  touch(key, nowMs + ADAPTIVE_COMPRESSION_SKIP_TTL_MS);
};

/** Test isolation. Production callers do not reset the cache. */
export const resetAdaptiveCompressionCache = (): void => {
  incompressibleUntil.clear();
};
