# Redis security checklist

This server uses Redis for four distinct concerns. Each one has its own URL env
and its own Prometheus metric set so failures stay isolated. All of them share
the same security recommendations below.

| Module | Env | Purpose |
| --- | --- | --- |
| `socket_io_redis_adapter.ts` | `SOCKET_IO_REDIS_ADAPTER_URL` | Cross-replica pub/sub for Socket.IO rooms |
| `socket_rate_limit_redis.ts` | `SOCKET_RATE_LIMIT_REDIS_URL` | Shared socket rate-limit counters |
| `rest_rate_limit_redis.ts` | `REST_RATE_LIMIT_REDIS_URL` | Shared `express-rate-limit` store |
| `client_socket_event_publish_idempotency_redis.ts` | `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL` | Distributed idempotency for `client:custom.*` publishes |

## 1. Always authenticate in production

Use one of:

- `rediss://default:<password>@host:6380` (TLS + auth — preferred)
- `redis://default:<password>@host:6379` (auth without TLS — only on a private
  network you fully control)

Plain `redis://host:6379` is acceptable in development only.

Set `STRICT_REDIS_AUTH=true` to make the boot fail when any of the four URLs
above use plain `redis://` without a password while `NODE_ENV=production`.

## 2. Prefer TLS

`rediss://` is the recommended scheme for any deployment that crosses VPC,
availability-zone, or cloud-provider boundaries. `node-redis` will negotiate
TLS automatically when the URL scheme is `rediss://`.

Managed Redis services (AWS ElastiCache, GCP Memorystore, Redis Cloud, Upstash,
Railway, etc.) typically expose `rediss://` endpoints out of the box.

## 3. Restrict network access

If running self-hosted Redis without TLS:

- Bind to `127.0.0.1` (single-node deploys) or to the private subnet only.
- Use a security group / firewall rule so only the hub replicas can reach it.
- Never expose 6379 to the public internet, even with a password.

## 4. Use ACLs for least privilege

The hub does not need administrative commands. When operating self-hosted
Redis ≥ 6, create an ACL user that only allows the commands actually used:

```
ACL SETUSER plug_hub on >StrongRandomPassword \
  ~plug_socket_rl:* ~plug_rl:* ~plug_socket_event_idem:* \
  ~plug_socket_event_idem_lock:* ~socket.io:* \
  +@read +@write +@stream +eval +pexpire +pttl +incrby +decrby +del \
  +set +get +xadd +xread +xack +xdel +xreadgroup +xlen
```

Adjust the namespaces to match `SOCKET_IO_REDIS_ADAPTER_KEY` if you customised
it. After the migration to hash tags (sprint 2 of the hardening plan) add
`{plug}` to the patterns: `~plug_socket_rl:{plug}:*` etc.

## 5. Memory and eviction

Rate-limit and idempotency keys carry their own TTL, so eviction policy choice
mostly affects what happens under memory pressure:

- `volatile-lru` is safe for the rate-limit/idempotency DB (only TTL'd keys
  are evicted).
- For the Streams DB introduced in sprint 4 (`AGENT_EVENT_STREAM_REDIS_URL`),
  use `noeviction` so backlog events are never silently dropped — sizing is
  capped via `XADD MAXLEN`.

Run rate-limits/idempotency and streams on **separate logical DBs** when
sharing a Redis instance, so an unbounded stream cannot crowd out rate-limit
state.

## 6. Observability

Each module emits the following Prometheus metrics (see `GET /metrics`):

- `plug_*_redis_url_configured` — gauge: 1 when a URL is set
- `plug_*_redis_active` / `plug_*_redis_store_active` — gauge: 1 when the
  client is healthy
- `plug_*_redis_connection_events_total` — counter
- `plug_*_redis_fallback_events_total` — counter (Redis unavailable, fell back
  to in-memory)
- `plug_*_redis_circuit_open` / `plug_*_redis_circuit_opened_total` — circuit
  breaker state for the rate-limit modules
- `plug_redis_*_command_duration_ms_bucket` (sprint 2) — per-command latency
  histogram

Alert on `fallback_events_total` rate or sustained `circuit_open == 1`.

## 7. Resilience defaults

`buildResilientRedisClientOptions` (`src/infrastructure/redis/redis_client_options.ts`)
sets `socket.connectTimeout` and a capped exponential `reconnectStrategy` on
every client. Override per-deployment via:

- `REDIS_DEFAULT_CONNECT_TIMEOUT_MS` (default 5000)
- `REDIS_DEFAULT_RECONNECT_BASE_MS` (default 200)
- `REDIS_DEFAULT_RECONNECT_MAX_MS` (default 5000)

The Socket.IO adapter keeps its own backoff envs for backwards compatibility:
`SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS` / `_RECONNECT_MAX_MS`.
