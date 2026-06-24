# ADR 0009: Client request id echo end-to-end (`clientRequestIdEcho` extension)

- **Status**: **Proposed** — not implemented. Tracks a future evolution
  of the relay `body.id` contract that supersedes the hub-side rewrite
  shipped in 2026-05.
- **Date**: 2026-05-28
- **Sprint**: TBD (gated on observation, see "Reabertura")

## Context

In May/2026 we corrected a JSON-RPC 2.0 §5 violation on the relay
unary fast-path: the hub was overwriting `body.id` of relay responses
with its internal `requestId` (UUID) instead of echoing the consumer's
original `id`. The defect made `fastPath: true` unusable
(`agent_sql_bridge_e2e_test.dart` went from 7s → 278s as every SQL
retried 3x). Detalhes em
[`docs/plug_agente/01_relay_body_id_echo.md`](../plug_agente/01_relay_body_id_echo.md).

The fix shipped as **Opcao B** (self-contained no hub): the hub keeps
overwriting `body.id` outbound to the agent (preserves the agent's
`RpcRequestGuard` replay cache, `rpc:request_ack` / `rpc:batch_ack`
correlation, log shapes), and **rewrites `body.id` back to the
consumer's `client_request_id`** when forwarding the response. The
rewrite costs one JSON parse + mutate + re-encode per relay unary
response — the `canBypassReencode` hot-path optimization in
`rpc_bridge_agent_inbound.ts` is sacrificed whenever
`clientRequestId !== requestId` (i.e., virtually always for relay).

The cost is small (~50-200 µs measured on synthetic benches; see
[`scripts/bench-relay-body-id-echo.ts`](../../scripts/bench-relay-body-id-echo.ts))
and tracked by the metric `plug_socket_relay_body_id_echo_total`
(count) + `plug_socket_relay_body_id_echo_overhead_avg_ms` (latency).
For workloads below ~10 K relay unary RPS the cost is invisible.

This ADR records the **future direction** (Opcao A) that would
eliminate the rewrite cost AND improve end-to-end observability, at the
price of a coordinated change in the `plug_agente` repository. It is
filed now so future contributors who think "we should make the agent
echo the client id directly" can find the reasoning, the required
agent-side changes, and the gates for promotion already laid out.

## Decision (proposed)

Introduce a negotiated transport extension
`clientRequestIdEcho: "v1"` on `agent:capabilities`. When **both** the
hub and the agent declare support during handshake, the wire contract
becomes:

| direction | `body.id` carries | `meta.request_id` carries | `envelope.requestId` carries |
| --------- | ----------------- | ------------------------- | ---------------------------- |
| hub → agent (`rpc:request`) | **`client_request_id`** (preserved end-to-end) | `hub_uuid` (wire correlator) | `hub_uuid` |
| agent → hub (`rpc:response`) | `client_request_id` (echoed) | `hub_uuid` (mirrored from request) | `hub_uuid` |
| hub → consumer (`relay:rpc.response`) | `client_request_id` (no rewrite needed) | `hub_uuid` (passthrough) | `hub_uuid` |
| agent → hub (`rpc:request_ack`) | n/a — see decision 2 | n/a | n/a |

When the extension is **not** negotiated (legacy agents, default), the
behavior remains identical to Opcao B as shipped: hub overwrites
`body.id` on dispatch, rewrites on response.

### 1. Negotiation

Hub side: extend `HUB_TRANSPORT_EXTENSIONS` in
`src/shared/constants/agent_transport_contract.ts`:

```ts
clientRequestIdEcho: "v1",
```

Agent side: extend `ProtocolCapabilities.serverDefault` in
`plug_agente/lib/domain/protocol/protocol_capabilities.dart` to echo
the same string when the agent runs a version that implements the
companion changes in §2-§4.

`ProtocolNegotiator` already merges agent + hub extensions; the
negotiated value lives in `negotiatedExtensions.clientRequestIdEcho`.
The hub reads it in `rpc_bridge_dispatch_relay.ts` to decide whether to
overwrite `body.id`.

### 2. Agent ack changes

`_emitRequestAck` and `_emitBatchRequestAck` in
`plug_agente/lib/infrastructure/external_services/transport/rpc_inbound_handler.dart`
and `rpc_batch_inbound_handler.dart` MUST use `request.meta.requestId`
(the hub UUID) as the `request_id` / `request_ids` payload instead of
`request.id.toString()`. Without this, hub-side ack correlation in
`handleAgentRpcAck` / `handleAgentBatchAck` breaks — the hub looks up
routes by `getRelayRequestRoute(requestId)` which is keyed on the UUID.

Concrete change (pseudo-Dart):

```dart
// rpc_inbound_handler.dart:_emitRequestAck
Future<void> _emitRequestAck(RpcRequest request) async {
  // Pre-extension: request_id = body.id (= hub_uuid via overwrite)
  // Post-extension: request_id = meta.requestId (always hub_uuid, regardless of body.id)
  final ackId = request.meta?.requestId ?? request.id?.toString();
  if (ackId == null) return;
  await _emitEvent('rpc:request_ack', {
    'request_id': ackId,
    'received_at': DateTime.now().toIso8601String(),
  });
}
```

The fallback `?? request.id?.toString()` keeps legacy agents (which
might not see `meta.requestId` on every request) safe.

### 3. Agent replay guard

`RpcRequestGuard.evaluate` in
`plug_agente/lib/infrastructure/external_services/rpc_request_guard.dart`
indexes `_recentRpcRequestIds` by `request.id?.toString()`. Today
`body.id == hub_uuid` so collisions are astronomically unlikely (UUIDs).
Post-extension, `body.id == client_request_id` which is
consumer-controlled.

The hub-side idempotency cache
(`relayIdempotencyTtlMs`, default **5 min**) covers the agent's replay
window (**2 min**, default). The hub dedupes duplicate
`client_request_id`s within its TTL before they reach the agent. So the
agent's replay guard would never trip due to consumer reuse within the
agent window. **No change required** to the guard in practice — but the
ADR records the analysis so the assumption is auditable.

If a future agent version chooses to harden by indexing replay on
`request.meta?.requestId` instead, it's safe (hub UUID is always
unique). The change is purely defensive.

### 4. Hub dispatch changes

`rpc_bridge_dispatch_relay.ts` lines 342-357 today overwrite `body.id`:

```ts
const commandPayload: Record<string, unknown> = {
  ...normalizedAndClamped,
  id: requestId,        // <- always hub_uuid
  api_version: ...,
  meta: { request_id: requestId, ... },
};
```

Post-extension, gate the overwrite by negotiation:

```ts
const echoClientId = agentRegistry
  .getNegotiatedExtensions(conversation.agentId)
  ["clientRequestIdEcho"] === "v1";

const commandPayload: Record<string, unknown> = {
  ...normalizedAndClamped,
  id: echoClientId && clientRequestId !== null ? clientRequestId : requestId,
  api_version: ...,
  meta: { request_id: requestId, ... },  // unchanged — always hub UUID
};
```

`rpc_bridge_agent_inbound.ts` response forwarder: when the route was
dispatched with `echoClientId`, the agent already sent back
`body.id == client_request_id`, so the `shouldEchoClientBodyId` gate
returns false and `canBypassReencode` becomes available again. Net
effect: bypass restored for negotiated agents, rewrite path preserved
for legacy agents.

### 5. Agent response preparer fix

`rpc_response_preparer.dart:73` today overwrites `meta.request_id` with
`response.id?.toString()`. Today this is a no-op (both are `hub_uuid`).
Post-extension, this would corrupt `meta.request_id` from `hub_uuid` to
`client_request_id`. Fix preemptively:

```dart
// Was: 'request_id': response.id?.toString(),
// New: prefer request meta over response id when they diverge.
'request_id': request.meta?.requestId ?? response.id?.toString(),
```

Requires plumbing `request` into `prepareForSend`. Refactor is small but
not zero. Recommended to ship **before** the extension lands so the
behavior is correct from day one.

## Alternatives considered

### Alternative 1: keep Opcao B forever

**Argument**: cost is ~50-200 µs per response; negligible at typical
RPS.

**Counter**: end-to-end observability is hurt — agent logs show
`request_id = hub_uuid`, consumer logs show
`client_request_id = client_uuid`, and the only way to correlate them
is via hub-side route lookup. For debugging field issues this is
friction.

**Decision**: keep Opcao B as the default for legacy agents; Opcao A
becomes the upgrade path for new agent versions.

### Alternative 2: agent emits a new `meta.client_request_id` field

**Argument**: avoid changing `body.id` semantics; add a side channel.

**Counter**: violates JSON-RPC 2.0 §5 (response.id must equal
request.id end-to-end). The whole point of this work is **compliance**.

**Decision**: rejected.

### Alternative 3: hub forwards consumer body verbatim (no UUID generation)

**Argument**: simplest contract.

**Counter**: hub needs internal `requestId` for routing, timeout
tracking, ack correlation, audit. Cannot reuse `client_request_id`
because consumers are not guaranteed unique across conversations / sockets.

**Decision**: rejected. UUID generation stays.

## Acceptance criteria (for v1 promotion)

A future PR implementing this ADR ships with:

- Hub: extension negotiation in `agent_transport_contract.ts`,
  conditional dispatch in `rpc_bridge_dispatch_relay.ts`, conditional
  rewrite skip in `rpc_bridge_agent_inbound.ts` when negotiated.
- Agent: ack helpers use `meta.requestId`, `prepareForSend` does not
  overwrite `meta.request_id`, capabilities declares
  `clientRequestIdEcho: "v1"`.
- Tests: hub-side test that with extension negotiated, `body.id` is NOT
  rewritten; with extension absent, behavior matches Opcao B exactly.
- Metric `plug_socket_relay_body_id_echo_total` drops to ~0 in
  deployments where all agents negotiate the extension.
- `plug_socket_relay_body_id_echo_overhead_avg_ms` no longer accumulates
  for negotiated agents.
- ADR status updated from "Proposed" to "Accepted — v1 shipped" with
  the PR link and date.

## Reabertura (gate de quando voltar a esse ADR)

Esta ADR fica em "Proposed" ate observamos uma das tres situacoes em
producao:

1. **`plug_socket_relay_body_id_echo_overhead_avg_ms` sustentado > 0.5 ms**
   em pico (medido em janela p95). Indica que a re-encode virou custo
   mensuravel.
2. **`plug_socket_relay_body_id_echo_total` sustentado > 1 K/s** em
   pico. Volume cumulativo virou CPU spend nao trivial.
3. **Requirement externo** (auditoria, conformidade, novo cliente alem
   da Colmeia) que exige `client_request_id` visivel nos logs do
   agente.

Reabrir a ADR significa: atualizar o status para "In Progress", abrir
PRs coordenadas no hub e no `plug_agente`, e atualizar
[`docs/plug_agente/03_performance_roadmap.md`](../plug_agente/03_performance_roadmap.md)
item 7 com link para os PRs e mudar Status para `in-progress`.

## GitHub issue template (`plug_agente`)

Use este texto ao abrir a issue de implementacao no repositorio do agente:

```markdown
## Summary
Implement `clientRequestIdEcho: "v1"` per ADR 0009 (Opcao A) so the hub can skip `body.id` rewrite on relay responses.

## Hub dependency
- ADR: plug_server `docs/adrs/0009-client-request-id-echo.md`
- Gate: `plug_socket_relay_body_id_echo_overhead_avg_ms` > 0.5 ms sustained OR external audit requirement

## Agent tasks
- [ ] Echo consumer JSON-RPC `id` on unary `rpc:response` when extension negotiated
- [ ] Keep `meta.request_id` as hub UUID for logs/acks
- [ ] Update `RpcRequestGuard` / replay cache to key on hub `request_id` only
- [ ] Contract tests with plug_server `tests/contract/`

## Acceptance
- Hub metric `plug_socket_relay_body_id_echo_total` stops growing for negotiated agents
- E2E relay fast-path suite passes without body-id rewrite
```

## References

- Defeito original + fix shipping (Opcao B): [`docs/plug_agente/01_relay_body_id_echo.md`](../plug_agente/01_relay_body_id_echo.md)
- Issue da Colmeia: `D:\Developer\Flutter\colmeia\docs\server_adjustments\relay_unary_fast_path.md §1`
- Contrato wire atual: [`docs/socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md) ("Relay unary fast-path", "Correlacao de IDs no relay")
- ADR irmao (batch protocol): [`docs/adrs/0008-relay-batch-protocol.md`](0008-relay-batch-protocol.md)
- Bench gate: [`scripts/bench-relay-body-id-echo.ts`](../../scripts/bench-relay-body-id-echo.ts) (BENCH=1)
