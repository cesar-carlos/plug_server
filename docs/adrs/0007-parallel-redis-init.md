# ADR 0007: Parallel Redis module initialization

- **Status**: Accepted
- **Date**: 2026-05-27
- **Sprint**: Redis performance v1 (Sprint P3.1)

## Context

`bootstrap()` in `src/server.ts` initializes four independent Redis-backed
modules sequentially:

```ts
await initRestHttpRateLimitRedis();
await initSocketRateLimitRedis();
await initClientSocketEventPublishIdempotencyRedis();
await initAgentEventStream();
```

Each init builds a resilient `node-redis` client through
`createInstrumentedRedisClient`, which:

1. Issues `connect()` with `redisDefaultConnectTimeoutMs` (default 5 s).
2. Performs a post-connect AUTH `PING`.
3. Runs the cluster topology validator (`CLUSTER INFO`).

In the happy path this costs ~5–10 ms per module. **In a degraded scenario
where one Redis URL is unreachable**, each module pays the full
`connectTimeoutMs` before falling back to in-memory state — and because
the awaits chain, the boot wait becomes:

```
total ≈ Σᵢ initᵢ
```

A single 5 s timeout on `socketRateLimit` blocks the rest of the boot for
5 s even though the other three Redis URLs are fine.

## Decision

Parallelize the four module inits using `Promise.all`:

```ts
await Promise.all([
  initRestHttpRateLimitRedis(),
  initSocketRateLimitRedis(),
  initClientSocketEventPublishIdempotencyRedis(),
  initAgentEventStream(),
]);
```

Total boot wait becomes `max(initᵢ)` instead of `Σᵢ initᵢ`.

Symmetrically, the shutdown path uses `Promise.allSettled` so a slow
`quit()` on one module does not block the others. Rejections are logged
at `warn` level (`redis_module_close_failed`) and shutdown still
completes.

The Socket.IO Redis adapter (`initSocketIoRedisAdapter`) stays outside
the parallel block because it depends on the `io` instance created by
`createSocketServer(httpServer)` later in the bootstrap. It still runs
sequentially after `createSocketServer` is called.

## Rationale

- **Independent state**: each Redis module owns its own client and
  metrics service. There is no shared mutable global state that would
  require ordering between them.
- **Fail-soft per module (ADR-0001)**: every init is already designed to
  log a warning and fall back to memory on failure. Running them in
  parallel does not change error semantics; it just removes the artificial
  serialization.
- **Boot-time visibility**: when one Redis URL is misconfigured, the
  parallel boot still produces a warning per module and the overall boot
  completes in the same time as the slowest individual init (which is
  bounded by `connectTimeoutMs`).
- **No shared connection pool**: each module's Redis client is a
  dedicated TCP connection. The four parallel `connect()` calls do not
  contend on a shared resource.

## Trade-offs

- **Logs interleave**: with parallel inits, the `*_connected` /
  `*_fallback_memory` log lines no longer appear in deterministic order.
  This is acceptable because each line carries the module name as the
  message prefix; operators correlating by `logName` are unaffected.
- **Overlapping cluster `CLUSTER INFO` probes**: in a Redis Cluster
  topology, the four modules each issue `CLUSTER INFO` near-simultaneously.
  Redis handles the duplicate inspection cheaply (~µs) so this is not a
  concern at boot scale.
- **No back-pressure**: a misbehaving Redis (e.g. a node accepting TCP but
  hanging on `PING`) consumes one connection per module in parallel
  instead of one at a time. The `connectTimeoutMs` already bounds the
  per-module wait, and four idle TCP sockets pre-timeout is negligible.

## Validation

- Tests in `tests/unit/server_bootstrap_parallel_init.test.ts` (added
  in Sprint P3) exercise the parallel boot with mixed success/failure
  outcomes per module and confirm:
  - Total boot time is bounded by the slowest individual init.
  - Each module's `init` is invoked exactly once.
  - A failure in one module does not abort the others.
- The shutdown path is asserted to invoke every `close*` even when one
  of them throws synchronously or asynchronously.
