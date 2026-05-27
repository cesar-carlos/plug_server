# ADR 0005: Two factories, four modules, one adapter

- **Status**: Accepted
- **Date**: 2026-05-26
- **Sprint**: Redis hardening v2

## Context

Five Redis-backed modules originally repeated ~80 lines each of
boilerplate: `createClient`, listener wiring, generation tokens, ping,
fallback handling. The v1 hardening sprint extracted
`createInstrumentedRedisClient` to consolidate single-client modules.
Sprint 6 added `createPubSubInstrumentedRedisClients` for the
adapter (which needs a paired pub+sub client).

## Decision

Two factory boundaries, deliberately:

- `instrumented_redis_client.ts` — single `createClient` connection.
  Used by the four single-client modules:
  - `socket_rate_limit_redis.ts`
  - `rest_rate_limit_redis.ts`
  - `client_socket_event_publish_idempotency_redis.ts`
  - `agent_event_stream.ts`
- `pubsub_instrumented_redis_client.ts` — paired `pub` + `sub` =
  `pub.duplicate()`. Used by `socket_io_redis_adapter.ts` only.

The adapter does **not** consume the single-client factory because:

- It manages two clients on the same connection options.
- It owns its own reconnect/backoff loop driven by
  `SOCKET_IO_REDIS_ADAPTER_RECONNECT_*` envs (legacy contract preserved).
- The `error`/`end` handler triggers an `attachInMemoryAdapter(io)`
  side-effect on the Socket.IO server, not just metrics.

## Rationale

- **Two factories, not one**: making the factory generic over N
  clients added more flexibility than we use. Two named factories are
  more readable; new modules pick the one matching their topology.
- **Adapter keeps custom logic**: the lifecycle differences
  (server-attach, reconnect-with-backoff, fallback adapter) are
  legitimate domain logic, not duplication.
- **Lua script cache** (`lua_script_cache.ts`) is per-module
  intentionally. Each module decides which scripts to pre-load and
  where the SHA-then-EVAL fallback falls back to.
- **Cluster topology validator** (`cluster_topology_validator.ts`) is
  invoked from each module's `init()` after connect, with module-
  specific sample keys. Centralising would force a single sample-key
  list across modules, defeating the purpose.

## Alternatives considered

- **Single mega-factory**: rejected for over-generalisation.
- **Adapter using single-client factory twice**: rejected because the
  adapter's lifecycle is too divergent from the single-client modules
  (server-attach, custom backoff). Wrapping it would add adapters
  on adapters.
- **Drop the factory entirely, inline everything**: rejected because
  the current factories save ~200 LOC across modules and centralise
  AUTH ping + post-connect contract.

## Maintenance contract

When adding a new Redis-backed module:

1. Decide between single-client (`createInstrumentedRedisClient`) or
   pub+sub (`createPubSubInstrumentedRedisClients`).
2. Define a metrics service mirroring the existing pattern
   (`*_redis_metrics.service.ts`) including a per-op latency histogram.
3. Use `LuaScriptCache` if you have Lua scripts.
4. Call `validateRedisClusterTopology` from `init()`.
5. Wire init/close in `server.ts`.
6. Update `health_redis.controller.ts` to include the new module.
7. Update the README under `src/infrastructure/redis/`.
