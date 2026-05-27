# Runbook: Migrate Redis from standalone to Cluster

This runbook walks through migrating the plug hub from a single-node Redis
to Redis Cluster (≥ 3 master nodes, optional replicas). The hub is already
cluster-aware:

- All keys carry the `{plug}` hash tag (ADR-0002) so multi-key Lua scripts
  land on the same slot.
- `cluster_topology_validator.ts` (Sprint 7) probes slot mapping at boot
  and warns if the topology is broken.
- Multi-tenancy via `REDIS_TENANT_ID` (ADR-0006, Sprint 12) keeps tenants
  on disjoint subspaces inside the same hash tag.

## Prerequisites

- New Redis Cluster (3+ masters; replica count up to operator). Recommended
  versions: Redis 7.x.
- Network connectivity from every hub replica to **every** Cluster node
  (clients negotiate topology dynamically — they MUST be able to follow
  `MOVED`/`ASK` redirects).
- Read access to the legacy standalone Redis from at least one machine
  (for the readiness check).
- Maintenance window of 5–15 min depending on traffic. Rate-limit windows
  in flight (~60 s) are lossy.

## Phase 1: Pre-flight readiness check

Run `scripts/redis-cluster-readiness-check.ts` against the **new** Cluster
endpoint. This script:

1. Connects with `node-redis@5` cluster client.
2. Verifies every plug-owned prefix maps to a single slot via
   `CLUSTER KEYSLOT`.
3. Issues sample `INCRBY`+`PEXPIRE` and Lua script load to confirm Cluster
   accepts plug's command repertoire.
4. Reports MOVED redirects (should be zero for any single multi-key
   script after warmup).

```bash
REDIS_CLUSTER_URLS="redis://node1:6379,redis://node2:6379,redis://node3:6379" \
  npx tsx scripts/redis-cluster-readiness-check.ts
```

Output is human-readable. Exit code `0` = ready, non-zero = blocking
issue. Do not proceed to Phase 2 until exit code is `0`.

## Phase 2: Stage rollout (read-only verification)

For deployments using read-replicas (Sprint 11
`REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_READ_URL`), point the read URL at
one Cluster master and leave the write URL on the legacy standalone.
This produces zero functional change but exercises the Cluster client
under real read traffic for 24-48 hours.

Watch:

- `plug_redis_auth_ping_total{outcome="auth_error|other_error"}` — should
  stay flat.
- `plug_socket_custom_event_idempotency_redis_command_duration_ms_p95` —
  acceptable if within 1.5× of the standalone baseline.

## Phase 3: Cutover

1. Notify the team and start the maintenance window.
2. Drain background work that can wait (registration email outbox flush,
   bridge latency trace flush — see `server.ts` shutdown sequence).
3. **Atomically** flip every `*_REDIS_URL` in your env to the new Cluster
   endpoint:
   - `SOCKET_IO_REDIS_ADAPTER_URL`
   - `REST_RATE_LIMIT_REDIS_URL`
   - `SOCKET_RATE_LIMIT_REDIS_URL`
   - `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL`
   - `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_READ_URL` (if used)
   - `AGENT_EVENT_STREAM_REDIS_URL` (if streams enabled)
4. Roll-restart hub replicas one by one. Each pod boot logs:
   - `*_redis_connected` — primary path healthy
   - `*_cluster_topology_ok` — slots co-located (validator success)
   - `auth_error|other_error` count = 0 in `plug_redis_auth_ping_total`
5. **Stop** the rollout if any replica logs `*_cluster_topology_crossslot`
   — see Phase 4 (rollback).

## Phase 4: Rollback

If anything goes wrong before all replicas are on the new Cluster:

1. Flip every URL back to the legacy standalone endpoint.
2. Roll-restart pods.
3. State loss in this rollback is the intersection of:
   - Rate-limit windows opened during the new-Cluster window (lost).
   - Idempotency entries written during the new-Cluster window (lost
     replay protection — at most a second window of duplicates).

Stream backlog frames written to the new Cluster do **not** transfer back
to the legacy node. If `AGENT_EVENT_STREAM_ENABLED=true`, decide between:

- **Accept the loss** (subscribers re-sync via live emit on next online
  publish — this is the same fail-open guarantee streams already
  provide).
- **Run a one-off `redis-cli COPY/MIGRATE`** from the new Cluster back to
  legacy for the impacted keys. Out of scope for this runbook.

## Phase 5: Decommission

After 7 days of healthy operation on Cluster:

1. Stop the legacy standalone Redis.
2. Remove standalone DNS record / DCS entry.
3. Update `docs/redis_security.md` deployment notes if needed.

## Multi-tenancy migration (optional)

If tenants share a single Cluster (ADR-0006), set `REDIS_TENANT_ID=<id>`
on each tenant's hub deployment. **Do not** set this env on a
single-tenant deployment after the fact: existing keys live under the
empty-tenant namespace and would become orphaned. To retroactively split:

1. Provision a fresh Cluster per tenant; OR
2. Schedule a destructive cutover identical to Phase 3 (rate-limit
   windows lose ~1 minute of state).

## Observability checklist

During Phase 3 cutover, these metrics MUST remain green:

- `plug_redis_auth_ping_total{outcome="ok"}` — incrementing every replica
  boot.
- `plug_socket_io_redis_adapter_active == 1`
- `plug_socket_rate_limit_redis_circuit_open == 0`
- `plug_rest_http_rate_limit_redis_circuit_open == 0`
- `plug_socket_rate_limit_redis_command_duration_ms_p95 < 250`
- `plug_agent_event_stream_dropped_total` — flat (no schemaVersion drift
  from Sprint 10).

The Grafana dashboard `docs/grafana/redis_dashboard.json` covers all of
these on a single screen.
