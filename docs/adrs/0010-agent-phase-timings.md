# ADR 0010: Per-phase agent timings (`meta.agent_phases`)

- **Status**: **Proposed** — hub ready (`requestServerTimings`); agent implementation pending in `plug_agente`.
- **Date**: 2026-06-24

## Context

The hub already supports opt-in `requestServerTimings: true` on `relay:rpc.request` and propagates `meta.serverTimings` on `relay:rpc.response` with hub-side phases (`consumer_frame_decode_ms`, `encode_ms`, `agent_to_hub_ms`, etc.). See [`docs/socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md).

`agent_to_hub_ms` dominates many workloads but does not explain **where** time is spent inside the agent (frame decode, SQL queue, DB, encode). Without agent-side phases, production investigations stall at "slow agent" with no drill-down.

## Decision

Introduce optional `meta.agent_phases` on agent-originated RPC responses when the consumer opted into server timings **and** the agent negotiates support via capabilities:

```json
{
  "extensions": {
    "agentPhaseTimings": "v1"
  }
}
```

### Wire shape (v1)

```json
{
  "meta": {
    "serverTimings": { "...": "hub phases unchanged" },
    "agent_phases": {
      "frame_decode_ms": 0.8,
      "sql_queue_wait_ms": 12.4,
      "sql_execute_ms": 340.1,
      "frame_encode_ms": 2.1
    }
  }
}
```

- All values are non-negative milliseconds (float OK).
- Hub forwards `agent_phases` unchanged on the relay path (no mutation).
- Hub MUST NOT synthesize agent phases — only the agent populates them.

## Hub work (this repo)

- [x] `requestServerTimings` on relay + batch (2026-06-24).
- [ ] Gate merging/display in runbooks when `agentPhaseTimings` extension is negotiated (documentation only until agent ships).
- [ ] Optional: extend `BridgeLatencyTraceSession` to persist `agent_phases` when present.

## Agent work (`plug_agente`)

- [ ] Emit `meta.agent_phases` on unary `rpc:response` when consumer requested timings and extension is negotiated.
- [ ] Instrument hot path in `rpc_inbound_handler` / `SqlExecutionQueue` without blocking the event loop.
- [ ] Contract test: hub contract suite accepts documented keys.

### GitHub issue template (`plug_agente`)

```markdown
## Summary
Ship `meta.agent_phases` per ADR 0010 when `agentPhaseTimings: "v1"` is negotiated.

## Tasks
- [ ] Extension `agentPhaseTimings` in `agent:capabilities`
- [ ] Phase timers: frame_decode, sql_queue_wait, sql_execute, frame_encode
- [ ] Populate `meta.agent_phases` only when hub sent `requestServerTimings: true`
```

## Gates

- Baseline: ≥ 100 samples with `requestServerTimings: true` showing `agent_to_hub_ms` > 70% of E2E without actionable sub-phases.
- Rollout behind extension negotiation — no behavior change for agents that do not advertise `agentPhaseTimings`.

## References

- [`docs/plug_agente/03_performance_roadmap.md`](../plug_agente/03_performance_roadmap.md) item 4
- [`docs/runbooks/socket_perf_investigation.md`](../runbooks/socket_perf_investigation.md)
