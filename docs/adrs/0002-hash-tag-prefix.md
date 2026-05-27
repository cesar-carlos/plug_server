# ADR 0002: `{plug}` hash tag in every Redis key prefix

- **Status**: Accepted
- **Date**: 2026-05-26
- **Sprint**: Redis hardening v2

## Context

Multi-key Lua scripts and Redis Cluster have a hard constraint: every
key referenced in a single script (`KEYS[1]`, `KEYS[2]`, ...) must hash
to the same slot, otherwise the server returns `CROSSSLOT`.

Until the v1 hardening sprint, our keys used flat prefixes:

- `plug_socket_rl:<scope>:<key>`
- `plug_rl:<scope>:<key>`
- `plug_socket_event_idem:<digest>`
- `plug_socket_event_idem_lock:<digest>`

These prefixes worked on standalone Redis but would scatter across
slots in Redis Cluster, breaking the consume/refund and
acquire/release/extend Lua scripts.

## Decision

Every plug-owned key embeds a `{plug}` hash tag. Redis only hashes the
content between `{` and `}` for slot assignment, so all our keys land
on the same slot regardless of the rest of the key:

- `plug_socket_rl:{plug}:<scope>:<key>`
- `plug_rl:{plug}:<scope>:<key>`
- `plug_socket_event_idem:{plug}:<digest>`
- `plug_socket_event_idem_lock:{plug}:<digest>`
- `plug_agent_stream:{plug}:<principalId>`
- `plug_agent_stream_cursor:{plug}:<principalId>`

The Socket.IO adapter (`@socket.io/redis-adapter`) has its own pub/sub
channel naming controlled by `SOCKET_IO_REDIS_ADAPTER_KEY` and was
left untouched (the library does not run multi-key Lua).

## Rationale

- **Cluster readiness for free**: today we run standalone Redis but
  the hash tag costs nothing on standalone (just a few extra bytes per
  key) and saves a destructive migration when migrating to Cluster.
- **Single slot for all keys**: simpler operational mental model. We
  do not have to worry about which keys appear together in a Lua
  script — they always co-locate.
- **Cluster topology validator** (`cluster_topology_validator.ts`)
  exercises this contract at boot, surfacing a misconfiguration before
  the first runtime command.

## Trade-offs

- All plug-owned keys live on the same slot. In Redis Cluster this
  creates a hot slot if our throughput grows. Mitigations: (a) different
  Redis databases for streams vs rate-limit (recommended), (b) future
  ADR can introduce per-domain hash tags (`{plug-rl}`, `{plug-stream}`)
  if hot-slot becomes a real bottleneck.

## Migration

Sprint 2 of the v1 hardening plan applied the prefix change destructively
in production: rate-limit counters lost ~1 minute of state and
idempotency entries were not migrated. Future prefix changes follow the
same playbook (CHANGELOG note + planned deploy window).
