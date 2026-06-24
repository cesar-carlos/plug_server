# Runbook: investigating Socket / relay performance

> **Owner**: Platform / Hub team. **Reach for this when**: latency or CPU
> regressed on relay or `agents:command` flows, or when a perf optimization
> proposal needs evidence before implementation.

This runbook walks through the **measure-before-optimize** loop mandated by
`.cursor/rules/performance.mdc`:

> *Optimize only after identifying the hot path, bottleneck, or operational
> limit being addressed. (...) document the assumption being optimized and
> verify the result with measurement or profiling.*

It maps the observability primitives shipped in Socket Performance v2 to
the questions perf investigations typically need to answer.

## Step 0 — Choose the channel and reproduction case

| Channel | Repro source |
| ------- | ------------ |
| Relay (`relay:rpc.request`) | Colmeia E2E `agent_query_across_agents_repositories_e2e_test.dart`, or load test with N concurrent consumers |
| `agents:command` (Socket) | Colmeia E2E with `AGENT_BRIDGE_TRANSPORT=socket E2E_DISABLE_RELAY_DISPATCH=true` |
| REST (`POST /api/v1/agents/commands`) | `tool/compare_e2e_transports.py --transport rest --runs N` (consumer-side) |

The relay channel is the **hot one** in production today. Default to it
unless the symptom is clearly REST-only.

## Step 1 — Capture per-phase latencies (consumer side opt-in)

Every flow above accepts the `requestServerTimings: boolean` opt-in (shipped
in Socket Performance v2). When `true`, the response carries
`meta.serverTimings.phasesMs` (relay) or a sibling `serverTimings` field
(`agents:command_response` / REST), see
[`docs/socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md) ("Server-side
phase diagnostics") and [`docs/api/api_rest_bridge.md`](../api/api_rest_bridge.md).

What you get per request:

| Phase key | What it represents | Tells you... |
| --- | --- | --- |
| `consumer_frame_decode_ms` | Hub-side decode of inbound PayloadFrame | Cost of receive (gunzip + JSON.parse + HMAC) |
| `relay_preflight_ms` | Validation + conversation lookup + capacity checks | Whether the dispatch slot or capacity is the bottleneck |
| `queue_wait_ms` (REST) | Wait in per-agent dispatch queue | Whether the agent is saturated |
| `encode_ms` | Hub→agent re-encode | JSON.stringify + optional gzip + sign |
| `emit_to_socket_ms` | Underlying Socket.IO write | Should be < 1 ms; > 5 ms = backpressure |
| `agent_to_hub_ms` | Wire + agent processing | Dominated by agent SQL time |
| `meta.agent_phases.*` (opt-in) | Agent sub-phases when `agentPhaseTimings` negotiated | Breaks down `agent_to_hub_ms` (frame decode, SQL queue, execute, encode) — see [ADR 0010](../adrs/0010-agent-phase-timings.md) |
| `inbound_decode_ms` | Hub-side decode of agent's response | Mirror of `consumer_frame_decode_ms` for inbound |
| `pending_resolve_ms` | Time to settle pending promise + dispatch follow-up | Should be near zero |
| `relay_forward_to_consumer_ms` | Hub→consumer emit time | Backpressure on the consumer socket |
| `response_write_ms` | Time to write HTTP response (REST) | TLS + socket flush; constant under stable load |

Capture **at least 100 samples** per route. Single-shot measurements are
noisy.

## Step 2 — Aggregate and identify the dominant phase

Use the client-side `tool/compare_e2e_transports.py --runs 5 --emit-phases`
(coming alongside the client opt-in adoption) or roll a quick aggregator if
testing manually:

```python
# pseudo
medians = {phase: median(samples[phase]) for phase in PHASES}
total   = sum(medians.values())
share   = {phase: medians[phase] / total for phase in PHASES}
sorted_share = sorted(share.items(), key=lambda kv: -kv[1])
print(sorted_share)
```

The first two entries are your **candidates**. Anything below 5 % is
noise — don't optimize it.

## Step 3 — Cross-reference with hub Prometheus metrics

`GET /metrics` exposes the relevant counters / histograms:

- `plug_socket_relay_bridge_encode_avg_ms` / `_p95`
- `plug_socket_relay_frame_decode_avg_ms` / `_p95`
- `plug_socket_relay_outbound_queue_overload_rejected_total`
- `plug_socket_relay_request_timeouts_total`
- `plug_socket_relay_fast_path_requested_total` / `_honored_total` /
  `_fallback_dedup_total` / `_fallback_error_total` /
  `_stream_inadvertent_total`
- `plug_socket_relay_server_timings_opt_in_total` etc.

Cross-reference: the consumer-side phase share **should agree** with the
hub-side fleet histograms within ~10 %. Disagreement >> 10 % means either
the load test is not representative, or there is a phase the per-request
snapshot does not capture (the snapshot is opt-in per request; the
histograms are fleet-wide).

## Step 4 — Decide the next action by dominant phase

| Dominant phase | Likely root cause | Recommended next action |
| --- | --- | --- |
| `agent_to_hub_ms` (> 70 %) | Agent / DB is the bottleneck | Focus optimization on `plug_agente`, not hub |
| `consumer_frame_decode_ms` + `encode_ms` (> 30 %) | CPU on hub forwarder | Implement Sugestão 1 (bypass re-encode) — see [`docs/spikes/`](../spikes/) and `git log` for the bypass in `rpc_bridge_agent_inbound.ts` |
| `queue_wait_ms` (> 20 %) | Per-agent saturation | Raise `SOCKET_RELAY_AGENT_MAX_INFLIGHT` / `SOCKET_RELAY_AGENT_MAX_QUEUE`, or scale agents |
| `relay_forward_to_consumer_ms` (> 10 %) | Consumer socket backpressure | Investigate consumer flow control / windowing |
| Hub `_avg_ms` low but consumer p99 high | Event loop blocking spikes | Look at `event_loop_lag_ms`; if HMAC is candidate, see [`docs/spikes/hmac_worker_offload.md`](../spikes/hmac_worker_offload.md) |
| Nothing clearly dominates (everything < 15 %) | Distributed cost, no easy win | Revisit architecture / batching (see ADR 0008) |

## Step 5 — Validate the fix the same way

After any perf change, re-run Step 1–3 with the same load and the change
applied. The win must show up in the **same dominant phase** that motivated
the change. If it doesn't, revert and reopen the investigation.

## Anti-patterns to avoid

- ❌ Implementing perf changes without first measuring the dominant phase
- ❌ Trusting a single-run number; always median over N≥5 runs
- ❌ Comparing dev laptop numbers against production numbers (TLS / network
  / CPU model differ enough to invalidate the comparison)
- ❌ Optimizing a phase < 5 % of the total (noise, not signal)
- ❌ Removing observability after the fix lands ("we don't need it anymore")
  — keep the opt-in in the suite for regression detection

## References

- Rule: `.cursor/rules/performance.mdc`
- Diagnostics protocol: `docs/socket/socket_relay_protocol.md` ("Server-side
  phase diagnostics")
- Diagnostics REST: `docs/api/api_rest_bridge.md` ("Server-side phase
  diagnostics")
- Existing study: `docs/studies/relay_fastpath_study.md`
- Pending spike (HMAC offload): `docs/spikes/hmac_worker_offload.md`
- Relay batch ADR (pending implementation): `docs/adrs/0008-relay-batch-protocol.md`
