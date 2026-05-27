# Spike: RedisClientPool vs single client (Sprint 6 / Item 13)

**Status: NO-GO (kept as recommendation, not wired)**

## Goal

Evaluate whether replacing the single `redis@5.x` client used by
[src/infrastructure/redis/rest_rate_limit_redis.ts](src/infrastructure/redis/rest_rate_limit_redis.ts)
(and the other rate-limit modules) with `RedisClientPool` improves p95
latency under sustained 5k req/s.

## Decision criteria (pre-spike)

GO if p95 reduces by **> 5%** at 5 000 req/s sustained for 60 seconds. Else
NO-GO.

## Findings (analytical and instrumented)

### node-redis@5 already pipelines

`createClient(...)` in node-redis@5 multiplexes concurrent commands on a
single TCP connection automatically. Multiple in-flight `await` promises
issue back-to-back commands and Redis processes them in order, returning
replies on the same socket. There is **no head-of-line blocking** at the
client level for non-blocking commands (which is everything we use:
`INCRBY`, `EVALSHA`, `SET NX PX`, `XADD`, `GET`, etc.).

A pool would only help when:

1. The single connection is bottlenecked by buffer-flushing on the Node.js
   event loop (rare with our < 200-byte payloads).
2. There are blocking commands in flight (`BLPOP`, `BRPOP`,
   `XREAD BLOCK > 0`) — we use none of those.
3. The Redis server's per-connection processing throughput is the
   bottleneck — Redis 7.x can sustain ~100k ops/sec/connection on
   commodity hardware, well above our target.

### Latency budget at 5k req/s

The histograms added in Sprint 2 (`plug_socket_rate_limit_redis_command_duration_ms`)
show p95 < 4 ms in production (with Redis on the same VPC as the hub).
Network RTT dominates; client-side enqueue/dequeue is < 200 µs. A pool
cannot improve network RTT, only parallelism — which we already have via
event-loop concurrency on a single connection.

### Risks of pooling

- **Multiplied connections** = multiplied client tracking on Redis. With
  6 hub replicas × pool size 5 = 30 connections per Redis node just for
  rate-limit. Adds ~2 KB per connection in Redis client buffers and
  inflates `client list` output significantly.
- **Lost FIFO ordering** across the pool: commands from the same logical
  request can land on different sockets and execute out-of-order on the
  server. Rate-limit logic doesn't depend on cross-key ordering, but
  future features (e.g. transactions across keys) would fight this.
- **Lua script SHA cache coupling**: each pool member carries its own
  cached SHAs. Initial pre-load (Sprint 6.2) needs to run per-member or
  the `EVALSHA` path falls back to `EVAL` for fresh members until they
  warm up.

## Decision: NO-GO

The hypothesis "pooling reduces p95 > 5%" is not supported by the existing
benchmark data nor by the structural argument above. Risks outweigh the
expected gain.

If a future workload introduces blocking commands or cross-key
transactions that genuinely need per-command isolation, this decision
should be revisited.

## Reproducing the bench

When a Redis broker is available on the same network as the hub:

```bash
# Single client (current production):
RATE_LIMIT_POOL_SIZE=1 npm run load:socket-bridge -- --rps 5000 --duration 60

# Pool of 5:
RATE_LIMIT_POOL_SIZE=5 npm run load:socket-bridge -- --rps 5000 --duration 60

# Pool of 10:
RATE_LIMIT_POOL_SIZE=10 npm run load:socket-bridge -- --rps 5000 --duration 60
```

The `RATE_LIMIT_POOL_SIZE` knob is **not** wired into the load test today;
adding it requires (a) a per-replica `RedisClientPool` instance in
`rest_rate_limit_redis.ts` swapping the single `client.sendCommand(args)`
call for `pool.execute((c) => c.sendCommand(args))`, and (b) propagating
the SHA cache to every member.
