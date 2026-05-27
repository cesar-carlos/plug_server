# ADR 0001: Fail-open as default for Redis-backed modules

- **Status**: Accepted
- **Date**: 2026-05-26
- **Sprint**: Redis hardening v2

## Context

The hub uses Redis for five concerns: Socket.IO adapter, two rate-limit
stores, distributed idempotency, and (opt-in) per-recipient backlog
streams. Each module must decide what happens when Redis is briefly or
permanently unavailable.

## Decision

All five modules **fail open**:

- An empty URL `*_REDIS_URL` makes the module a no-op. The hub continues
  with local-only behaviour (per-replica state).
- A boot-time connection failure logs `*_redis_fallback_memory` and
  continues. The Socket.IO adapter has a hard-fail override
  (`SOCKET_IO_REDIS_ADAPTER_REQUIRED=true` or `NODE_ENV=production`)
  because cross-replica fan-out cannot be papered over silently in
  multi-replica deployments.
- Runtime errors trigger module-specific recovery: rate-limit modules
  open a 5-second circuit; the adapter schedules a backoff reconnect
  while serving from the in-memory adapter; idempotency falls back to
  per-replica memory.

## Rationale

The hub is a critical path for both REST and Socket workloads. Making
Redis a hard dependency would multiply blast radius — a brief Redis
incident would degrade or kill the hub even when the local cache /
memory store could keep serving correctly.

Trade-offs:

- Local rate-limits become per-replica during outages, allowing up to
  N× the configured `max` across replicas.
- Idempotency may double-publish a frame across replicas when both
  succeed during a Redis blip.
- Socket.IO adapter falling back means cross-replica broadcasts stop —
  acceptable while the watchdog reconnects (~seconds).

These costs are small compared to the alternative (process restarts and
unavailability).

## Alternatives considered

- **Fail-closed in production**: would require operators to provision a
  Redis HA pair from day one. Considered for the adapter only because
  silent fallback there breaks correctness. Adopted as opt-in
  (`SOCKET_IO_REDIS_ADAPTER_REQUIRED`).
- **Hybrid (some modules fail-closed, some fail-open)**: rejected for
  inconsistency. Operators benefit from a single mental model.
