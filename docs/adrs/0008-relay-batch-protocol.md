# ADR 0008: Relay JSON-RPC batch protocol (`relay:rpc.request.batch`)

- **Status**: **Accepted — v1 implemented 2026-05-28**
- **Date**: 2026-05-28 (proposal) / 2026-05-28 (v1 shipped)
- **Sprint**: Socket performance v2

## Context

Today the relay channel rejects batch requests:

```207:211:src/presentation/socket/hub/relay/rpc_bridge_dispatch_relay.ts
    if (Array.isArray(rawCommand)) {
      throw relayRpcRefundableBadRequest(
        "relay:rpc.request does not support batch; send a single JSON-RPC request",
      );
    }
```

REST and `agents:command` already accept JSON-RPC batches (up to 32 items per
envelope, single `agentId` per envelope). Cross-agent fan-out via `mergeAll`
on the relay channel therefore pays:

- 1 consumer→hub wire emit per RPC (no batching)
- 3 events on the wire per RPC (`request`, `accepted`, `response`) before the
  fast-path opt-in lands (see `docs/socket_relay_protocol.md` "Relay unary
  fast-path")

The Colmeia client's proposal
([`docs/server_adjustments/relay_rpc_batch_protocol.md`](../../../Flutter/colmeia/docs/server_adjustments/relay_rpc_batch_protocol.md)
in the client repo) sketches a new event `relay:rpc.request.batch`. The
proposal is sound in intent but leaves three contract gaps that block
implementation. This ADR records the decisions that close those gaps so the
implementation can proceed in a focused follow-up sprint without re-debating
them.

## Status: v1 shipped 2026-05-28

This ADR shipped as **v1** alongside the new event
`relay:rpc.request.batch` and the helper handler
[`src/presentation/socket/consumers/relay_rpc_request_batch.handler.ts`](../../src/presentation/socket/consumers/relay_rpc_request_batch.handler.ts).
The canonical contract for consumers lives in
[`docs/socket_relay_protocol.md`](../socket_relay_protocol.md) ("Relay
JSON-RPC batch") which supersedes any divergence with this document.

The single-RPC dispatcher `relay:rpc.request` continues to reject array
commands; multi-item batching now flows through the new event.

### v1 deltas from this ADR

- **Decision E (per-item idempotency)**: implemented as designed.
- **Decision C (per-socket inflight gate all-or-nothing)**: implemented
  via the new `tryAcquireSocketInflightSlots`.
- **Decision F (streaming items rejected in v1)**: implemented.
- **`requestServerTimings` / `fastPath` on the envelope schema**: accepted
  by the Zod schema for forward-compat with v2, but **NOT** propagated to
  per-item dispatch in v1. v2 will refactor the relay dispatcher to expose
  a pre-decoded entry point that supports per-item timings and fast-path.
- **Per-item PayloadFrame synthesis**: v1 trades the architecturally
  cleaner pre-decoded entry point for a localized handler that synthesizes
  one PayloadFrame per item internally. Cost is one extra encode/decode
  per item; v2 will eliminate it.

## Decisions

### 1. Event shape

New event on `/consumers`:

```text
event: relay:rpc.request.batch
inbound envelope (JSON, not PayloadFrame): {
  conversationId: string,
  frame: PayloadFrame,                  // payload.data is the JSON-RPC array
  payloadFrameCompression?: "default" | "none" | "always",
  requestServerTimings?: boolean,
  fastPath?: boolean
}
```

The frame's logical payload (`decoded.value.data`) MUST be a JSON-RPC array
of 1–32 single-RPC items (`bridgeBatchCommandSchema`). The hub re-uses the
existing schema for validation — no new validator.

### 2. Reply shape: per-item correlation, single batch ack

Two events on the response side:

- `relay:rpc.batch_accepted` (JSON, not PayloadFrame), emitted **once** per
  inbound batch envelope, mirroring `rpc:batch_ack` on the `/agents`
  namespace:

  ```text
  payload: {
    success: true,
    conversationId: string,
    batchSize: number,
    items: [
      {
        clientRequestId: string,
        requestId: string,
        deduplicated?: boolean,
        replayed?: boolean,
        inFlight?: boolean
      },
      ...
    ]
  }
  ```

  Or `{ success: false, error: {...} }` for envelope-level rejection (eg
  batch too large, unsupported method in any item, capacity).

- `relay:rpc.response` (PayloadFrame, existing event), emitted **per item**
  exactly as today. Per-item failures live inside the JSON-RPC envelope as
  `error`; the rest of the batch keeps executing — matching `agents:command`
  batch semantics.

**Decision A:** `batch_accepted` carries per-item correlation + dedup state
in a single emit. Consumers reconcile `clientRequestId` → `requestId`
mapping once per batch instead of N times.

**Decision B:** when consumers send `fastPath: true` on the batch envelope,
the hub still emits `relay:rpc.batch_accepted` for the batch — the fast-path
optimization removes per-item `relay:rpc.accepted` emits but **not** the
batch ack, which is the only place where dedup mapping for N items can be
delivered atomically. Per-item responses then arrive via `relay:rpc.response`
without further accepteds.

### 3. Per-socket inflight gate: 1 slot per item, not 1 per envelope

Today `tryAcquireSocketInflightSlot` reserves one
`SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET` slot per event handler entry
(`relay_rpc_request.handler.ts:98`). For batch this would underestimate the
load — a 32-item batch is 32 logical operations.

**Decision C:** the batch handler acquires N slots — one per item —
atomically. If only K < N are available, the **entire batch is rejected**
with a single `relay:rpc.batch_accepted { success: false, error: {
code: "RATE_LIMITED", details: { availableSlots: K, requestedSlots: N } } }`.
The consumer can retry with a smaller batch or wait. Half-acceptance is
rejected as a contract complexity that buys nothing.

### 4. Per-agent dispatch slots: 1 slot per item

`acquireRelayAgentDispatchSlot` (one slot per `SOCKET_RELAY_AGENT_MAX_INFLIGHT`)
also runs per dispatch today. For batch:

**Decision D:** each item acquires a separate per-agent slot. Items wait in
the per-agent queue (`SOCKET_RELAY_AGENT_MAX_QUEUE`) when the inflight cap is
reached, **on the same envelope context**. The handler does not partially
emit while waiting — the `batch_accepted` is sent **after** all slot
acquisitions succeed (or the batch is rejected at envelope level via
`SOCKET_RELAY_AGENT_QUEUE_WAIT_MS`).

This adds latency-to-first-ack for the batch in saturated conditions, but
preserves the existing per-agent fairness model. A future refinement could
trickle items through as they acquire slots, but that requires `batch_accepted`
to support partial emission — out of scope for v1.

### 5. Per-conversation idempotency: per item

`relay_idempotency_store` keys by `(conversationId, clientRequestId)`.

**Decision E:** each item runs the full idempotency check independently. If
≥1 item collides with an in-flight or cached entry, those specific items
return `deduplicated: true` in `batch_accepted.items[k]` (plus `replayed`
or `inFlight` as today). The other items proceed normally. **Partial
deduplication is the explicit happy path** — it lets the client retry a
batch where some calls were already accepted without forcing a full re-send.

This matches the per-item correlation model on REST batches.

### 6. Streaming items: rejected in v1

`sql.execute` with `prefer_db_streaming` / `multi_result`, `sql.executeBatch`,
or any method that would open a stream MUST be rejected at validation if
present in a batch envelope. Mixed unary+streaming batches require
window/credit coordination per item that the current relay flow cannot
express atomically.

**Decision F:** v1 returns
`relay:rpc.batch_accepted { success: false, error: { code: "BATCH_STREAMING_ITEM_REJECTED", message: "Batch items must be unary", details: { itemIndex: k } } }`
when any item is streaming-capable. v2 may relax this.

### 7. Signing & compression

PayloadFrame envelope rules unchanged. The HMAC/signature operates over the
**whole batch frame**, not per item, mirroring the current `rpc.request`
contract. The hub re-encodes one outbound `rpc:request` **per item** to the
agent (the agent has no batch ingress that the hub can leverage without a
plug_agente change).

This means batching saves consumer→hub wire emits but not hub→agent wire
emits. The win is on the consumer side, where the WebSocket emit overhead +
JSON parse + envelope decode + gate check + rate limit consume dominates.
That matches the measurement scope in the original proposal.

### 8. Metrics

Following `.cursor/rules/performance.mdc` ("document the assumption being
optimized and verify the result with measurement"), the v1 implementation
SHALL expose the following histograms on `/metrics`:

- `plug_socket_relay_batch_items_per_envelope` (histogram, labels:
  `outcome` ∈ `{accepted, rejected, partial_dedup}`)
- `plug_socket_relay_batch_envelopes_total` (counter, labels:
  `outcome`)
- `plug_socket_relay_batch_per_agent_queue_wait_ms` (histogram, labels:
  `agent_id`)
- `plug_socket_relay_batch_envelope_decode_ms` (histogram)

The existing per-item phase metrics (encode, queue wait, etc.) continue to
fire per item, so existing dashboards keep working.

### 9. Configuration

New env keys, default values aligned with `agents:command` batch:

- `SOCKET_RELAY_BATCH_ENABLED` (default `false` until the feature ships)
- `SOCKET_RELAY_BATCH_MAX_ITEMS` (default `32`, mirrors
  `HUB_MAX_BATCH_SIZE`)

The dispatcher behind `relay:rpc.request.batch` checks
`SOCKET_RELAY_BATCH_ENABLED`; when off, returns `success: false` with code
`RELAY_BATCH_DISABLED` and a 503 retry hint. The single-request event
`relay:rpc.request` is unaffected by this flag.

## Consequences

**Positive**

- Closes the open spec questions before code lands.
- Reuses existing batch validation, idempotency, and per-agent dispatch
  primitives — minimal new code surface.
- Backwards-compatible: existing `relay:rpc.request` event unchanged.
- Per-item correlation preserves the JSON-RPC `clientRequestId`
  contract that the rest of the protocol already relies on.

**Negative**

- Per-envelope inflight gate (Decision C) rejects partial batches even
  when half the slots are free. A future flag could relax this to
  "best-effort partial accept" if measurements show high rejection rates.
- The batch envelope ack (`batch_accepted`) waits for all slot
  acquisitions — adds latency-to-first-ack under saturation. Acceptable
  for v1; v2 may stream `batch_accepted.items` incrementally.

**Neutral**

- The hub→agent leg remains N emits — this ADR does not introduce
  agent-side batching.
- The implementation effort is contained to one new handler file and a
  small extension to `relay_request_registry` (no schema migration).

## Implementation checklist

- [x] New event constants `relayRpcRequestBatch` + `relayRpcBatchAccepted`
      in `socket_events.ts`.
- [x] New handler `relay_rpc_request_batch.handler.ts` with the inflight
      gate behaviour from Decision C.
- [x] New env keys + validation in `env.ts` (`SOCKET_RELAY_BATCH_ENABLED`,
      `SOCKET_RELAY_BATCH_MAX_ITEMS`).
- [x] Documentation updates in `docs/socket_relay_protocol.md` ("Relay
      JSON-RPC batch").
- [x] Unit tests covering: happy path, gate rejection, streaming item
      rejection, exceeds max items, duplicate ids, validation failure,
      partial dedup.
- [x] Metrics surface (`plug_socket_relay_batch_*` counters in
      `metrics_renderer.ts`).
- [ ] **v2 follow-up**: refactor `dispatchRelayRpcToAgent` to expose a
      pre-decoded entry point so batch dispatch skips the per-item encode
      round-trip AND can honor `requestServerTimings` / `fastPath` per
      item.
- [ ] **v2 follow-up**: Grafana panel update for the new counters.
- [ ] **v2 follow-up**: `RelayBatchEnvelopeRoute` type linking batch ack
      to per-item routes for audit-log correlation.

## References

- Client proposal:
  [Flutter/colmeia/docs/server_adjustments/relay_rpc_batch_protocol.md](../../../Flutter/colmeia/docs/server_adjustments/relay_rpc_batch_protocol.md)
- Current relay protocol: [docs/socket_relay_protocol.md](../socket_relay_protocol.md)
- Existing batch on REST/Socket: [docs/api_rest_bridge.md](../api_rest_bridge.md)
- Companion Item 3 (unary fast-path), already shipped:
  see "Relay unary fast-path" in `docs/socket_relay_protocol.md`.
- Companion Item 4 (phase diagnostics), already shipped:
  see "Server-side phase diagnostics" in the same doc.
