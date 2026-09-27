# Performance roadmap — arquivo

> **Arquivo.** Status vivo: [`README.md`](README.md).
> Ledger de commits e arquivos: [`04_agent_implementation_status.md`](04_agent_implementation_status.md).
> Itens **1–9** e hub **H1–H12** shipped. Unico aberto: **item 10 (brotli)**.
>
> O passo a passo de implementacao dos itens entregues saiu desta pagina.
> Repetia o ledger, citava linhas de codigo e o bloco `Unreleased` do
> changelog de 2026-05, e descrevia trabalho que nao esta mais aberto.

## Sumario

| # | Item | Status |
| - | ---- | ------ |
| 1 | `enableSocketDeliveryGuarantees=true` | shipped 2026-05-28 [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) |
| 2 | `enableSocketStreamingChunks=true` | shipped 2026-05-28 [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) |
| 3 | Coalescing `rpc:request_ack` → `rpc:batch_ack` | shipped 2026-05-28 [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) |
| 4 | `meta.agent_phases` | shipped 2026-06-24 — [ADR 0012](../adrs/0012-agent-phase-timings.md) |
| 5 | Health piggyback | shipped 2026-06-24 — [ADR 0011](../adrs/0011-health-piggyback.md) |
| 6 | `recommendedStreamPullWindowSize` default 8 | shipped 2026-05-28 [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) |
| 7 | `clientRequestIdEcho: "v1"` | shipped 2026-06-24 — [ADR 0009](../adrs/0009-client-request-id-echo.md) |
| 8 | `prepareForSend` preserva `meta.request_id` | shipped 2026-05-28 [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) |
| 9 | Pre-warm de schema validators | shipped 2026-05-28 [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) |
| 10 | Compressao brotli | proposed — [study](../studies/brotli_payload_frame_study.md), gates em [P5](../performance/P5_future_gates.md) |

Extensoes de transporte: ADR **0009**, **0011** e **0012**. ADR **0010** e
presenca Redis no hub, nao `agentPhaseTimings`.

## Hub-side (sem mudanca no agente)

| Item | Status |
| ---- | ------ |
| H1 | Batch `preDecodedData` — [ADR 0008](../adrs/0008-relay-batch-protocol.md) |
| H2 | Ack forward em bytes, sem re-`JSON.stringify` |
| H3 | Idempotency waiters em `Set` |
| H4 | Batch v2: `requestServerTimings` / `fastPath` por item |
| H5 | `findPrincipalAccessCheck` (1 RTT em cache miss) |
| H6 | Cache LRU da canonical string HMAC |
| H7 | Histogramas de batch + dashboard Grafana |
| H8 | Extensoes ADR 0009 / 0011 / 0012 — [`560ef2f`](https://github.com/cesar-carlos/plug_server/commit/560ef2f) |
| H9 | `parallelBatchDispatch` em `agent:capabilities` |
| H10 | Poll opcional `AGENT_HEALTH_POLL_ENABLED` (default `false`) — [ADR 0011](../adrs/0011-health-piggyback.md) |
| H11 | Metricas late-response / outbound-failure / adocao de `parallelBatchDispatch` (2026-07-07) |
| H12 | Hot path 2026-08 (prune, menos alocacao no inbound). Contrato publico inalterado |

## 10. Compressao brotli

Hub e agente negociam `gzip` e `none`. Brotli fica `proposed`: Dart precisa
de codec extra e nao ha evidencia de banda como gargalo. Reabre pelos gates
do [study](../studies/brotli_payload_frame_study.md) e de
[P5](../performance/P5_future_gates.md).

## Itens explicitamente recusados

- **Batch outbound de `rpc:response`.** O hub rejeita arrays em `rpc:response`.
- **Eliminar `RpcRequestGuard`.** O agente mantem replay local se o mesmo `body.id` chegar por outro caminho.
- **`maxConcurrentRpcHandlers` abaixo de 32** sem o hub. O teto espelha `SOCKET_RELAY_AGENT_MAX_INFLIGHT`.
- **Trocar Drift por Hive/Isar** no store de idempotencia. Sem evidencia de que SQLite e o gargalo.

## Medicao

Baseline e fases: [`socket_perf_investigation.md`](../runbooks/socket_perf_investigation.md).
Nao reabrir os itens 1–9 sem um gate novo. O item 10 so entra quando
bytes-on-wire for o gargalo medido.
