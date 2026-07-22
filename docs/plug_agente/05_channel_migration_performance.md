# P4 — Migração de canal para desempenho (hub ↔ agente)

> **Audiencia.** Times do consumer, ops e integradores. Checklist curto;
> tuning detalhado em
> [`../performance/performance_hub_agent.md`](../performance/performance_hub_agent.md).

## Objetivo

Reduzir latência e RAM ao evitar REST materializado e re-encode desnecessário no relay.

## 1. REST streams grandes → relay

| Evitar | Preferir | Métrica de sucesso |
| ------ | -------- | ------------------ |
| `POST /api/v1/agents/commands` + `sql.execute` com `stream_id` | `relay:*` + `stream_pull` em tempo real | `plug_rest_sql_stream_materialize_*` desce |
| SELECTs grandes só via HTTP | Socket relay ou `agents:command` com chunks | Menor RSS do hub, menor p95 |

Referencia: [`../api/api_rest_bridge.md`](../api/api_rest_bridge.md), [`../socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md).

## 2. Fast-path + Opcao A (`clientRequestIdEcho`)

Requisitos (deploy coordenado hub + agente `2.11.2+`):

1. Handshake com `extensions.clientRequestIdEcho === "v1"` nos dois lados.
2. Consumer relay: `fastPath: true` no envelope `relay:rpc.request`.
3. Em erros, o hub **sempre** emite `relay:rpc.accepted { success: false }`
   (mesmo com `fastPath: true`) e ecoa `conversationId` / `clientRequestId`
   quando conhecidos — o consumer **deve** usar esses campos para liquidar
   pendings indexados por `clientRequestId` (evita hang até o timer local).
4. Validar em `/metrics`:
   - `plug_socket_relay_body_id_echo_total` → ~0
   - `plug_socket_relay_fast_path_honored_total` sobe

Referencia: [`01_relay_body_id_echo.md`](01_relay_body_id_echo.md), [`../studies/relay_fastpath_study.md`](../studies/relay_fastpath_study.md), [`../socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md) ("Relay unary fast-path").

## 3. `timeoutMs` no envelope (paridade REST)

- Sem `timeoutMs`, o hub espera `SOCKET_RELAY_REQUEST_TIMEOUT_MS` (default **30000** ms).
- O timer local do consumer (`bridgeTimeoutMs`) **não** estende a espera do hub.
- Se `sql.execute` (ou batch) puder passar de ~15–30s, enviar `timeoutMs` no
  envelope de `relay:rpc.request` / `relay:rpc.request.batch` (teto 360000 ms).
- Em estouro: `relay:rpc.response` com `error.data.code = "RELAY_REQUEST_TIMEOUT"`.

Referencia: [`../socket/socket_client_sdk.md`](../socket/socket_client_sdk.md) (`timeoutMs`), [`../socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md) ("Per-request timeout").

## 4. Batch relay (opt-in — sem mudar default)

- Consumer deve emitir `relay:rpc.request.batch` **e** ops setar
  `SOCKET_RELAY_BATCH_ENABLED=true` (default hub = `false`; ver `.env.example`).
- Não ligar o flag em produção até o cliente estar no evento batch.
- No batch, `timeoutMs` / `fastPath` / `requestServerTimings` do envelope
  propagam para cada item; rejeição do envelope ecoa `conversationId` quando parseado.

Referencia: [ADR 0008](../adrs/0008-relay-batch-protocol.md), [`../socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md) ("Relay JSON-RPC batch").

## 5. Parâmetros no agente (sem mudança no hub)

- `options.prefer_db_streaming: true` em SELECTs elegíveis.
- `options.max_parallel_read_only_batch_items` em `sql.executeBatch` (pass-through validado no hub).

## 6. Observabilidade

- `requestServerTimings: true` no consumer + `agentPhaseTimings` negociado → `meta.agent_phases` (ADR 0012).
- Baseline antes/depois: `npm run perf:baseline` (ver [`../performance/load_testing.md`](../performance/load_testing.md)).

## Checklist de rollout P4

1. Confirmar agentes com `clientRequestIdEcho` negociado.
2. Habilitar `fastPath` nos clientes relay para cargas de alta cardinalidade.
3. Tratar `relay:rpc.accepted { success: false }` com eco de `conversationId` / `clientRequestId`.
4. Enviar `timeoutMs` quando o SQL puder passar do default do hub (30s).
5. Migrar fluxos com `stream_id` no REST para relay.
6. Só depois: habilitar `SOCKET_RELAY_BATCH_ENABLED` quando o consumer usar `relay:rpc.request.batch`.
7. Re-snapshot métricas 15–30 min após cada mudança de canal.
