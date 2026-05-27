# ADR 0004: Circuit breaker thresholds (3 failures / 5 seconds)

- **Status**: Accepted
- **Date**: 2026-05-26
- **Sprint**: Redis hardening v2

## Context

Both rate-limit modules (`socket_rate_limit_redis.ts`,
`rest_rate_limit_redis.ts`) implement a per-process circuit breaker
that opens after consecutive Redis command failures. Open state
short-circuits subsequent commands (`null`/`unavailable` return) so the
hub does not pile up timeouts when Redis is genuinely down.

The thresholds are hardcoded:

```
const redisCircuitFailureThreshold = 3;
const redisCircuitOpenMs = 5_000;
```

## Decision

Keep the values as constants (not envs) for now:

- **3 consecutive failures** before opening the circuit.
- **5 000 ms** open window before the next half-open probe (one command
  attempt; success closes, failure re-opens).

## Rationale

- **3 failures** = fewer than the 20-attempt default reconnect loop in
  `node-redis`, so we open the circuit while the underlying client is
  still trying to reconnect. This avoids the false "Redis is up but
  every command times out" symptom.
- **5 000 ms** open window matches the default `connectTimeout` and
  `REDIS_DEFAULT_RECONNECT_MAX_MS`. Operators can reason about a single
  number across all Redis-touching code paths.
- Constants over envs reduces operator surface area: the values are
  empirically good for our workload (verified via
  `socket_rate_limit_redis.test.ts` failure-mode tests). If a future
  workload demonstrates a need for tuning, promote to env at that point.

## Alternatives considered

- **Envs for both values**: rejected because we have no production
  signal that the defaults are wrong, and adding envs without a
  workload-driven need adds operational confusion.
- **Adaptive thresholds (e.g. exponential)**: over-engineering for a
  fail-open module where the worst case is "rate-limit becomes
  per-replica for 5 s".
- **Token-bucket-style breaker**: more accurate but heavier; current
  count-based breaker is sufficient for the on/off semantics we need.

## Revisit triggers

- Persistent `circuit_open` alerts (see `docs/observability/alerts/redis.yml`)
  with no Redis incident → threshold may be too sensitive.
- Recurring "fallback storms" without circuit opening → threshold may
  be too loose.
