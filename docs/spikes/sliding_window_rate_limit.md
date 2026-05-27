# Spike: sliding-window rate limit (Sprint 6 / Item 12)

**Status: NO-GO (kept for reference, not wired into production)**

## Goal

Compare a sliding-window rate-limit (Sorted Set + Lua) against the current
fixed-window (counter + TTL) implementation in
[src/infrastructure/redis/socket_rate_limit_redis.ts](src/infrastructure/redis/socket_rate_limit_redis.ts).

The hypothesis was that a sliding-window eliminates the boundary burst
problem (where 2× the configured `max` requests can fit in 2 ms straddling
two adjacent fixed windows).

## Spike branch

Self-contained implementation in
[src/infrastructure/redis/socket_rate_limit_redis_sliding.ts](src/infrastructure/redis/socket_rate_limit_redis_sliding.ts):

- Single Lua round-trip per consume:
  `ZREMRANGEBYSCORE → ZCARD → conditional ZADD → PEXPIRE`.
- One Sorted Set entry per accepted request.
- Bounded retention via `PEXPIRE` with the same `windowMs`.

## Decision criteria (pre-spike)

GO required both:

- (a) Latency p95 ≤ 1.5× the fixed-window baseline at 5k req/s sustained.
- (b) Memory cost acceptable (< 2 KB per active key under typical load).

NO-GO if either fails or the boundary-burst observed in production telemetry
proves negligible.

## Findings (analytical)

### Latency

Both implementations issue a single Lua round-trip after Sprint 6.1 + 6.2,
so network latency is identical. The sliding-window Lua does more work per
call:

- Fixed-window Lua (after S6.1):
  `INCRBY` → branch → optional `PEXPIRE` / `PTTL`+`PEXPIRE`. Worst-case 3
  Redis primitives, all O(1).
- Sliding-window Lua:
  `ZREMRANGEBYSCORE` (O(log N + M) where M = entries removed),
  `ZCARD` (O(1)),
  `cost` × `ZADD` (each O(log N)),
  `PEXPIRE` (O(1)).

For typical hub workloads (`max = 60–600`, `cost = 1`), the additional
ZSET operations add ~10–20 µs per consume on a single-threaded Redis 7.x
running on commodity hardware. That fits within the 1.5× envelope under
moderate load but **erodes under contention**: when many keys ride a single
Redis socket, the extra Lua time blocks every other command on that
connection.

Verdict on (a): **passes for moderate load, marginal under high concurrency.**

### Memory

Per-key memory under steady-state load with `max = N`:

- Fixed-window: 8 bytes counter + ~80 bytes Redis overhead ≈ **88 bytes/key**.
- Sliding-window: `N` Sorted Set entries × ~70 bytes each (member + score +
  skiplist pointers) ≈ **70 × N bytes/key**.

For `max = 100`, sliding-window costs ~7 KB per active key vs ~88 bytes
for fixed-window — **80× memory amplification**. With 10 000 active keys
this is the difference between ~880 KB and ~70 MB of Redis memory.

Verdict on (b): **fails the < 2 KB/key bar at any non-trivial `max`.**

### Boundary-burst observability

We sampled `plug_socket_rate_limit_redis_rejected_total` and the per-bucket
allowed counters across last 30 days of production logs (excerpts in
`docs/observability.md`). The boundary effect is bounded by the maximum
ratio `2 × max / windowMs` and capped further by the in-process limiter
in [src/presentation/socket/hub/rate_limits/](src/presentation/socket/hub/rate_limits/)
which uses sliding-window already (in-process is cheap because no network).

We did **not** observe a single incident attributable to fixed-window
boundary bursts in the 30-day window.

## Decision: NO-GO

The spike is not wired into production for these reasons:

1. **Memory cost is unacceptable** at typical `max` values without operator
   tuning — and the operator has no signal to tune this differently from
   today.
2. **Marginal latency win**, sometimes a regression, under high concurrency.
3. **No observed incident** the sliding-window would have prevented in
   production telemetry.
4. The in-process layer (per-replica) already mitigates boundary effects
   for the same scope before any Redis call happens.

The branch is kept in the repository for future reference; if a specific
scope (e.g. credential auth bursts) ever motivates strict semantics, this
file is a starting point.

## Re-validation telemetry (Sprint 11)

Two new counters were added to feed the next review of this decision:

- `plug_socket_rate_limit_window_resets_total` — number of times a Lua
  consume call created a new window key (`usedRaw === cost`). High rate
  means rapid window churn.
- `plug_socket_rate_limit_window_saturations_total` — number of times a
  consume request was allowed exactly at `used === max`. High rate means
  the window is reaching its budget cap before expiring.

The boundary-burst risk is a function of:

```
saturation_ratio = saturations / window_resets
```

When `saturation_ratio > 0.5` sustained for a week on a scope with
`windowMs >= 60_000`, the boundary-burst exposure is significant enough
to outweigh the memory cost of sliding-window. Re-run the analytical
analysis with that data.

## Reproducing the bench

When a Redis broker is available locally:

```bash
# Fixed-window baseline:
npm run load:socket-bridge -- --rate-limit-mode fixed --duration 60 --rps 5000

# Sliding-window:
npm run load:socket-bridge -- --rate-limit-mode sliding --duration 60 --rps 5000
```

The CLI flags do not yet exist in `scripts/socket-bridge-load-test.mjs`;
they need to be added if/when the spike is revisited. The
`consumeSlidingWindowRateLimit` function is exported for direct use in any
ad-hoc benchmark script.
