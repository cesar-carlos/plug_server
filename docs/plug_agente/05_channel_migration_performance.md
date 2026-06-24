# P4 — Migração de canal para desempenho (hub ↔ agente)

> **Audiencia.** Times do consumer (Colmeia), ops e integradores. Complementa
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
3. Validar em `/metrics`:
   - `plug_socket_relay_body_id_echo_total` → ~0
   - `plug_socket_relay_fast_path_honored_total` sobe

Referencia: [`01_relay_body_id_echo.md`](01_relay_body_id_echo.md), [`../studies/relay_fastpath_study.md`](../studies/relay_fastpath_study.md).

## 3. Parâmetros no agente (sem mudança no hub)

- `options.prefer_db_streaming: true` em SELECTs elegíveis.
- `options.max_parallel_read_only_batch_items` em `sql.executeBatch` (pass-through validado no hub).

## 4. Observabilidade

- `requestServerTimings: true` no consumer + `agentPhaseTimings` negociado → `meta.agent_phases` (ADR 0010).
- Baseline antes/depois: `npm run perf:baseline` (ver [`../performance/load_testing.md`](../performance/load_testing.md)).

## Checklist de rollout P4

1. Confirmar agentes com `clientRequestIdEcho` negociado.
2. Habilitar `fastPath` nos clientes relay para cargas de alta cardinalidade.
3. Migrar fluxos com `stream_id` no REST para relay.
4. Re-snapshot métricas 15–30 min após cada mudança de canal.
