# ADR 0011: Health snapshot piggyback on RPC responses

- **Status**: **Proposed** — requires coordinated schema in `plug_agente`.
- **Date**: 2026-06-24

## Context

The hub polls agent health via `agent.getHealth` on a timer. For busy agents this adds periodic RPC traffic and duplicates information already computable at response time (`sql_queue_pressure`, `active_streams`, circuit state).

## Decision

Allow the agent to attach a **freshness-bounded** health snapshot to every Nth unary `rpc:response` when negotiated:

```json
{
  "extensions": {
    "healthPiggyback": { "intervalRequests": 50, "freshnessThresholdMs": 5000 }
  }
}
```

### Wire shape (v1)

```json
{
  "meta": {
    "health_snapshot": {
      "captured_at_ms": 1719234567890,
      "sql_queue_pressure": 0.42,
      "active_streams": 2,
      "circuit_state": "closed"
    }
  }
}
```

Hub behavior:

1. When `health_snapshot.captured_at_ms` is within `freshnessThresholdMs`, skip the next scheduled `agent.getHealth` poll for that agent.
2. When stale or missing, fall back to explicit `agent.getHealth`.
3. Never trust piggyback for authorization — observability only.

## Hub work (this repo)

- [ ] ADR accepted (this document).
- [ ] Extend `agentRegistry` / health scheduler to honor piggyback freshness.
- [ ] Metrics: `plug_agent_health_piggyback_used_total` vs `plug_agent_health_poll_total`.

## Agent work (`plug_agente`)

- [ ] Sample health evaluator on response path (every N requests).
- [ ] Cap snapshot size; avoid large nested objects.
- [ ] Tests for interval and freshness fields.

### GitHub issue template (`plug_agente`)

```markdown
## Summary
Ship health piggyback per ADR 0011 to reduce `agent.getHealth` poll traffic.

## Tasks
- [ ] Negotiate `healthPiggyback` extension with interval + freshness
- [ ] Attach `meta.health_snapshot` on every Nth unary response
- [ ] Keep snapshot small (queue pressure, streams, circuit state)
```

## Gates

- Measure current `agent.getHealth` volume in production; pursue only if poll rate is material (> 1 req/s per agent at p95).

## References

- [`docs/plug_agente/03_performance_roadmap.md`](../plug_agente/03_performance_roadmap.md) item 5
