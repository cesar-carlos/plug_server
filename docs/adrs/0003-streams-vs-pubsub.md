# ADR 0003: Streams as opt-in backlog buffer beside pub/sub adapter

- **Status**: Accepted
- **Date**: 2026-05-26
- **Sprint**: Redis hardening v2

## Context

`@socket.io/redis-adapter` fans out `socket:event.publish` frames to all
hub replicas via Redis pub/sub. Pub/sub is fire-and-forget: a subscriber
that disconnects between publish and reconnect (potentially landing on a
different replica) loses every frame published while disconnected.

For some product flows this is a tolerable best-effort delivery (e.g.
real-time alerts where the next state will arrive imminently anyway).
For others — audit feeds, settlement notifications, etc. — losing a
frame requires manual reconciliation.

## Decision

Redis Streams (`agent_event_stream.ts` + `agent_event_stream_cursor.ts`)
are a **second-tier durable buffer alongside the existing pub/sub
adapter**, not a replacement.

- Pub/sub stays the fast online path (latency dominated by network RTT).
- Streams append happens **after** the live emit, on the same publish
  path, only when `AGENT_EVENT_STREAM_ENABLED=true`.
- Drain happens on `socket:event.subscribe` ack: the consumer reads
  `lastSeenStreamId` from a per-principal cursor and emits matching
  frames serially with ack-based confirmation.
- `MAXLEN ~ N` bounds storage; `PEXPIRE` per append handles idle
  cleanup; `XDEL` after ack keeps active streams trim.

## Rationale

- **Default off keeps current behaviour**: enabling streams costs
  Redis memory linearly with active recipients × `MAX_LEN` × frame
  size. Operators opt in only when they need at-least-once delivery
  for a specific scope.
- **No fork in the publish path**: every frame still goes through
  `consumersNsp.to(room).emit(...)`. The stream append is additional
  work, not a replacement.
- **Cursor per principal, not per (principal, eventName)**: keeps
  Redis cardinality bounded. The drain filters by event name at read
  time. Trade-off: clients subscribing to many events drain the same
  stream multiple times — acceptable because most subscribers have a
  small subscription set.
- **Allowlist for rollout**: `AGENT_EVENT_STREAM_AGENT_ALLOWLIST`
  restricts the durable backlog to specific principal ids during gradual
  enablement.

## Alternatives considered

- **Replace pub/sub with Streams entirely**: rejected because online
  delivery would gain ~1 ms per hop (XADD round-trip), and pub/sub
  delivers correctly to everyone-online which is the common case.
- **Per (principal, eventName) stream key**: rejected because
  cardinality balloons (`active_principals × subscriptions_per_principal`
  streams).
- **Consumer groups (`XGROUP CREATE`, `XREADGROUP`)**: deferred. Adds
  pending-entries-list bookkeeping that we don't need yet because we
  drain serially per principal. Revisit if multiple replicas drain the
  same principal in parallel.
