# ADR 0011: Health snapshot piggyback on RPC responses

- **Status**: **Accepted — v1 shipped (partial scheduler)** (hub [`560ef2f`](https://github.com/cesar-carlos/plug_server/commit/560ef2f);
  agent [`741b5677`](https://github.com/cesar-carlos/plug_agente/commit/741b5677), 2026-06-24).
  Piggyback consumption + metrics live; scheduled `agent.getHealth` poll skip
  hook exists but no hub timer calls it yet (optional follow-up).
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

- [x] ADR accepted (this document).
- [x] `agent_health_piggyback.service.ts` — freshness validation + per-agent state.
- [x] Forwarder hook (`maybeRecordAgentHealthPiggyback`) on non-`agent.getHealth` unary responses.
- [x] `agentRegistry.shouldSkipScheduledHealthPoll()` + `clearAgentHealthPiggybackState` on disconnect.
- [x] Metrics: `plug_agent_health_piggyback_used_total` vs `plug_agent_health_poll_total`.
- [ ] Optional: hub scheduler/timer that calls `shouldSkipScheduledHealthPoll` before emitting
  scheduled `agent.getHealth` (only valuable when explicit poll volume is material).

## Agent work (`plug_agente`)

- [x] `RpcHealthPiggybackSampler` on unary response path (every N requests).
- [x] Compact snapshot (`sql_queue_pressure`, `active_streams`, `circuit_state`, etc.).
- [x] Tests: `rpc_inbound_response_enricher_test`, negotiator coverage.

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
