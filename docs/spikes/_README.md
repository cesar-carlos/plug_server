# Spikes index

Time-boxed experiments evaluated during the Redis hardening sprints. Each
spike has a sibling document with the methodology, decision criteria, and
final GO / NO-GO outcome. Code that supports the spike is kept under
`src/infrastructure/redis/*_sliding.ts` (etc.) until the decision is
revisited or the branch is removed.

## Index

| Spike | Status | Document | Implementation branch |
| --- | --- | --- | --- |
| Sliding-window rate limit | NO-GO | [sliding_window_rate_limit.md](sliding_window_rate_limit.md) | [src/infrastructure/redis/socket_rate_limit_redis_sliding.ts](../../src/infrastructure/redis/socket_rate_limit_redis_sliding.ts) |
| RedisClientPool for REST rate-limit | NO-GO | [redis_client_pool.md](redis_client_pool.md) | (no branch — analytical only) |
| HMAC worker-thread offload | Gated / revisit | [hmac_worker_offload.md](hmac_worker_offload.md) | ver doc + runbook de signing |

## When to revisit

A NO-GO is **provisional**: the analytical reasoning that produced it
holds for the current workload, not forever. Revisit a spike when any of
these triggers fires:

### Sliding-window rate limit

- Boundary-burst telemetry (`plug_socket_rate_limit_window_boundary_observations_total`,
  added in Sprint 11) shows ≥ 1 observation per 5 minutes sustained for a
  week. Boundary effects start to dominate when the underlying ratio
  `2 × max / windowMs` matters in real traffic.
- A new scope is added with `windowMs ≤ 1000` and `max ≤ 10`. Fixed-window
  becomes lossy at that resolution.
- Memory budget for Redis grows ≥ 8 GiB per node. The 80× memory
  amplification we ruled out becomes affordable.

### RedisClientPool

- A blocking command (e.g. `BLPOP`, `BRPOP`, `XREAD BLOCK > 0`) is
  introduced into the hub. Single-connection multiplexing fails for
  blocking commands.
- p95 of `plug_socket_rate_limit_redis_command_duration_ms` exceeds
  20 ms sustained AND the bottleneck is **Node-side** (not Redis CPU).
  Profile via OpenTelemetry spans (`REDIS_OTEL_SPANS_ENABLED=true`) to
  confirm before re-running the bench.
- Sustained > 10 000 req/s rate-limit traffic with measurable head-of-line
  blocking on the single TCP connection.

### HMAC worker offload

- `requestServerTimings` / load tests show HMAC verify as a material share of
  event-loop time on large frames (see spike doc gates).
- Do not implement on speculation — compression/gunzip is the likelier CPU cost.

## Adding a new spike

1. Create the implementation branch under `src/infrastructure/redis/`
   (or another suitable directory) named with `_spike.ts` or `_<topic>.ts`
   suffix. Mark with a top-of-file comment "EXPERIMENTAL (spike)".
2. Add `docs/spikes/<topic>.md` with: goal, decision criteria
   (pre-spike), findings (analytical and instrumented), GO / NO-GO
   decision, reproduction steps.
3. Append an entry to this index.
4. If GO: promote the branch into production, add an ADR, drop the
   `_spike` suffix. Keep the spike doc as historical.
5. If NO-GO: keep the branch as reference unless it conflicts with
   maintenance. Update this README's "When to revisit" section with
   concrete triggers.
