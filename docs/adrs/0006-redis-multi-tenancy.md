# ADR 0006: Multi-tenancy via REDIS_TENANT_ID

- **Status**: Accepted
- **Date**: 2026-05-27
- **Sprint**: Redis hardening v3 (Sprint 12)

## Context

Multiple plug deployments (separate organisations / brands / environments
sharing the same Redis cluster) need hard isolation of:

- Rate-limit counters (one tenant should not deplete another's budget).
- Idempotency entries (replay tokens are per-tenant).
- Agent event stream backlog and cursor (deliver to the right tenant).

Until Sprint 12, every key prefix carried a static `{plug}` hash tag so
`plug_*:{plug}:*` keys were single-tenant by construction.

## Decision

Add an opt-in `REDIS_TENANT_ID` env. When set, every Redis-backed module
embeds the tenant id **inside the hash tag braces** so all keys for the
same tenant land on the same Redis Cluster slot:

- `REDIS_TENANT_ID=""` (default) →  `plug_socket_rl:{plug}:scope:user:abc`
- `REDIS_TENANT_ID="acme"`        →  `plug_socket_rl:{plug}:acme:scope:user:abc`

The shared helper `src/infrastructure/redis/redis_key_namespace.ts` exports
`redisKeyNamespace()` returning `"{plug}"` or `"{plug}:<tenant>"`. Every
module that previously used the literal `{plug}` calls the helper.

Validation:

- `REDIS_TENANT_ID` must match `^[A-Za-z0-9_-]{1,32}$` when non-empty.
  Boot fails on invalid input.
- Empty (default) preserves the current single-tenant key shape exactly,
  so single-tenant deployments observe no change.

## Rationale

- **Hard isolation**: per-tenant prefix subspaces guarantee no cross-tenant
  state mixing. `KEYS plug_socket_rl:{plug}:acme:*` returns acme's
  counters only.
- **Cluster-friendly**: keeping tenant id inside the hash tag keeps all
  tenant keys on the same slot, so multi-key Lua scripts (consume +
  refund, lock + extend) still work.
- **Single env knob**: deployment topology change is a one-env edit.
- **Operationally cheap**: no schema migration on day one because the
  default keeps existing keys exactly where they are.

## Trade-offs

- **Cross-tenant queries are impossible** by design. If aggregate
  reporting across tenants is later required, run it from a separate
  metrics pipeline (Prometheus dashboards span all replicas regardless
  of tenant).
- **Tenant churn requires key cleanup**. Rotating `REDIS_TENANT_ID`
  orphans the previous subspace; rely on per-key TTL or run a manual
  `SCAN` + `DEL` job during the rotation.
- **All tenants share the same Redis instance** for now. Scaling
  isolation further (separate Redis nodes per tenant) is out of scope
  and would deserve a fresh ADR.

## Migration

1. Operators leave `REDIS_TENANT_ID` empty for single-tenant deployments
   — nothing changes.
2. To split a single Redis between tenants:
   - Stand up the new tenant deployment with `REDIS_TENANT_ID=<tenant>`.
   - The new tenant's keys appear under the `{plug}:<tenant>` subspace
     immediately; no migration of existing keys required because the
     tenant has no prior state.
3. To retroactively shift existing single-tenant data into a tenant
   subspace, run a server-side `SCAN` + key rename or accept a
   destructive cutover (rate-limit windows lose ~1 minute of state).

## Cluster topology validator

`cluster_topology_validator.ts` already accepts arbitrary sample keys.
Each module's init now passes the namespace-aware sample keys via
`redisKeyNamespace()` so the validator probes the correct slots when
`REDIS_TENANT_ID` is set.
