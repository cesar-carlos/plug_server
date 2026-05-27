/**
 * **EXPERIMENTAL** sliding-window rate limit branch (Sprint 6 spike).
 *
 * Not wired in production. Kept alongside the fixed-window implementation
 * (`socket_rate_limit_redis.ts`) so the spike can be benchmarked A/B on a
 * staging Redis. Decision recorded in
 * [docs/spikes/sliding_window_rate_limit.md](docs/spikes/sliding_window_rate_limit.md).
 *
 * @todo {2026-Q3 review} Sprint 11 added `windowResetsTotal` and
 * `saturationsTotal` to the socket rate-limit metrics service. When
 * `(saturationsTotal / windowResetsTotal) > 0.5` sustained for a week on a
 * scope where `windowMs >= 60000`, that's the trigger to revisit this
 * NO-GO decision (see `docs/spikes/_README.md` for the full criteria).
 *
 * Algorithm (single Lua round-trip):
 *
 *   1. `ZREMRANGEBYSCORE key 0 (now - windowMs)`  — drop expired entries
 *   2. `ZCARD key`                                 — current usage
 *   3. If `usage + cost > max` -> reject (no insert)
 *   4. Else `ZADD key now memberId` (unique per request)
 *   5. `PEXPIRE key windowMs`                      — bound retention
 *   6. Return `{ allowed, used }`
 *
 * Memory: each in-flight request stores ~24 bytes per Sorted Set entry +
 * skiplist pointers. Steady-state ~50 bytes/entry. Worst-case for a key
 * with `max = N` is `N * 50` bytes. Compare to fixed-window `8 bytes` per
 * counter — sliding-window costs ~6× more per key.
 *
 * The script is cached via `LuaScriptCache` once a real wiring decision is
 * made. For the spike branch we keep an inline EVAL so the implementation
 * is self-contained and easy to copy into a separate benchmark script.
 */

import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import type { InstrumentedRedisClient } from "./instrumented_redis_client";

export interface SlidingRateLimitInput {
  readonly key: string;
  readonly windowMs: number;
  readonly max: number;
  readonly cost?: number;
}

export interface SlidingRateLimitResult {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly latencyMs: number;
}

/**
 * Lua script: atomic check-and-set on a Sorted Set keyed by request memberId.
 *
 * KEYS[1]  = sliding window Sorted Set
 * ARGV[1]  = now (ms since epoch)
 * ARGV[2]  = window in ms
 * ARGV[3]  = max requests in window
 * ARGV[4]  = cost (number of members to insert)
 * ARGV[5]  = memberId base (uuid + ":")
 *
 * Returns { allowed (1|0), used }.
 */
const SLIDING_WINDOW_SCRIPT = `
local nowMs = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxReq = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local memberBase = ARGV[5]
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, nowMs - windowMs)
local current = tonumber(redis.call('ZCARD', KEYS[1]))
if current + cost > maxReq then
  return {0, current}
end
for i = 1, cost do
  redis.call('ZADD', KEYS[1], nowMs, memberBase .. tostring(i))
end
redis.call('PEXPIRE', KEYS[1], windowMs)
return {1, current + cost}
`;

export const consumeSlidingWindowRateLimit = async (
  client: InstrumentedRedisClient,
  input: SlidingRateLimitInput,
): Promise<SlidingRateLimitResult | null> => {
  if (input.max <= 0 || input.windowMs <= 0) {
    return null;
  }
  const cost = Math.max(1, Math.floor(input.cost ?? 1));
  const startedAtMs = performance.now();
  try {
    const result = (await client.eval(SLIDING_WINDOW_SCRIPT, {
      keys: [input.key],
      arguments: [
        String(Date.now()),
        String(input.windowMs),
        String(input.max),
        String(cost),
        `${randomUUID()}:`,
      ],
    })) as [number, number] | unknown;
    if (!Array.isArray(result) || result.length !== 2) {
      return null;
    }
    const allowedFlag = Number(result[0]);
    const used = Number(result[1]);
    const allowed = allowedFlag === 1;
    return {
      allowed,
      used,
      limit: input.max,
      remaining: Math.max(0, input.max - used),
      latencyMs: performance.now() - startedAtMs,
    };
  } catch {
    return null;
  }
};
