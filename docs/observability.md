# Observabilidade

Este documento concentra metricas, traces, alertas e sinais operacionais do
hub. Regras de negocio e semantica de autorizacao ficam em
`docs/client_agent_business_rules.md`. Defaults e variaveis ficam em
`docs/configuration.md`. Tuning operacional fica em
`docs/performance_hub_agent.md`. Mapa geral: `docs/README.md`.

## Endpoints

- `GET /metrics` — texto Prometheus (alias util fora do prefixo `/api/v1`).
- `GET /api/v1/metrics` — mesmo payload.

## Comeco rapido

Se fores olhar so o minimo:

1. valida `GET /metrics`
2. acompanha throughput/falhas do bridge REST
3. acompanha backlog/p95 da fila relay outbound
4. acompanha bloqueios/rate limits e falhas de auditoria

## Metricas uteis (exemplos PromQL)

Ajuste nomes ao scrape target do teu Prometheus. Exemplos genericos:

```promql
# Taxa de pedidos REST ao bridge de agentes (counter real: plug_rest_bridge_requests_total)
# Nota: estes contadores incrementam no handler HTTP depois de auth + rate limits da rota;
# rejeições 401/429 antes do handler não entram aqui (usar plug_rest_http_rate_limit_* quando aplicável).
rate(plug_rest_bridge_requests_total[5m])

# Sucesso vs falha (cada pedido incrementa `requests_total` uma vez)
rate(plug_rest_bridge_requests_success_total[5m])
rate(plug_rest_bridge_requests_failed_total[5m])

# Fracao de sucesso (~1.0 se estavel); `clamp_min` evita divisao por zero no arranque
rate(plug_rest_bridge_requests_success_total[5m])
  / clamp_min(rate(plug_rest_bridge_requests_total[5m]), 0.001)

# Pulls internos ao materializar stream SQL via REST
rate(plug_rest_sql_stream_materialize_pulls_total[5m])
rate(plug_rest_sql_stream_materialize_completed_total[5m])
rate(plug_rest_sql_stream_materialize_rows_merged_sum[5m])

# Cortes por orçamento na materialização REST (streams grandes → preferir Socket)
rate(plug_rest_sql_stream_materialize_row_limit_exceeded_total[5m])
rate(plug_rest_sql_stream_materialize_chunk_limit_exceeded_total[5m])

# Gauge: materializações REST ainda sem rpc:complete
plug_rest_sql_stream_materialize_streams_in_flight

# Rejeições REST antes do dispatch (motivo separado; legado = soma dos três)
rate(plug_socket_relay_rest_global_pending_cap_rejected_total[5m])
rate(plug_socket_relay_rest_agent_queue_full_rejected_total[5m])
rate(plug_socket_relay_rest_agent_queue_wait_timeout_rejected_total[5m])
rate(plug_socket_relay_rest_pending_rejected_total[5m])

# Rate limiting relay por identidade (scope=user|anon)
rate(plug_socket_relay_rate_limit_conversation_start_rejected_total[5m])
rate(plug_socket_relay_rate_limit_request_rejected_total[5m])
rate(plug_socket_relay_rate_limit_stream_pull_credits_rejected_total[5m])
sum by (scope) (plug_socket_relay_rate_limit_stream_pull_credits_granted_total)

# Fila por agente no bridge REST (agregado, baixa cardinalidade)
plug_socket_relay_rest_dispatch_inflight_total
plug_socket_relay_rest_dispatch_queued_waiters_total
plug_socket_relay_rest_dispatch_agents_with_queue
plug_socket_relay_rest_dispatch_max_queue_depth

# HTTP Express: rate limit antes do parse JSON em `/api/v1` + limite da rota `/agents/commands`
rate(plug_rest_http_rate_limit_global_rejected_total[5m])
rate(plug_rest_http_rate_limit_agents_commands_user_rejected_total[5m])
rate(plug_rest_http_rate_limit_agents_commands_ip_rejected_total[5m])

# Relay: pedidos aceites vs rejeitados por rate-limit
rate(plug_socket_relay_rate_limit_request_allowed_total[5m])
rate(plug_socket_relay_rate_limit_request_rejected_total[5m])

# Fila hub→consumer relay (gzip async serializado por requestId): taxa de jobs e falhas
rate(plug_socket_relay_outbound_queue_jobs_finished_total[5m])
rate(plug_socket_relay_outbound_queue_jobs_failed_total[5m])

# Custos do hot path relay (média por fase)
plug_socket_relay_overload_check_avg_ms
plug_socket_relay_frame_decode_avg_ms
plug_socket_relay_command_validate_avg_ms
plug_socket_relay_bridge_encode_avg_ms
plug_socket_relay_chunk_forward_jobs_avg_ms
plug_socket_relay_buffer_drain_avg_ms

# Gauge: `requestId` com cadeia de emit ainda nao drenada (0 em repouso)
plug_socket_relay_outbound_queue_inflight_request_ids

# Socket legado agents:command (mesma janela/max que REST por utilizador; contador separado)
rate(plug_socket_agents_command_rate_limit_allowed_total[5m])
rate(plug_socket_agents_command_rate_limit_rejected_total[5m])

# Contas bloqueadas (login/refresh/socket negados por status; sem PII nos labels)
rate(plug_auth_login_blocked_total[5m])
rate(plug_auth_refresh_blocked_total[5m])
rate(plug_auth_socket_blocked_total[5m])

# Alteracoes de estado por admin (bloquear/desbloquear via PATCH /admin/users/:id/status)
rate(plug_admin_user_status_set_total[5m])

# Rate limit no PATCH de estado (por admin)
rate(plug_rest_http_rate_limit_admin_user_status_rejected_total[5m])

# Alertas (exemplos): muitas tentativas de login bloqueadas (possivel abuso ou lista de contas)
rate(plug_auth_login_blocked_total[5m]) > 0.5
```

Regras de transicao e API: `docs/user_status.md`.

Use `GET /metrics` num ambiente de desenvolvimento e copie os nomes exatos dos contadores expostos (podem evoluir com o CHANGELOG).

## Snapshot minimo para tuning hub ↔ agente

Quando fizer tuning no bridge/relay, recolha estes pontos no mesmo intervalo
antes e depois da mudanca:

- `plug_socket_relay_outbound_queue_backlog`
- `plug_socket_relay_outbound_queue_job_duration_p95_ms`
- `plug_socket_relay_bridge_encode_avg_ms`
- `plug_socket_relay_frame_decode_avg_ms`
- `plug_rest_bridge_requests_total` e `plug_rest_bridge_requests_failed_total`
- `plug_socket_relay_rest_global_pending_cap_rejected_total`
- `plug_socket_audit_writes_attempted_total` e `plug_socket_audit_writes_sample_skipped_total`
- `plug_rest_sql_stream_materialize_completed_total`

Isto cobre capacidade, custo de CPU no caminho quente, impacto de auditoria e
degradacao funcional. Para presets de tuning e rollout, ver
`docs/performance_hub_agent.md`.

## Tabela PostgreSQL `bridge_latency_traces` (latencia por fase)

Com `BRIDGE_LATENCY_TRACE_ENABLED=true`, o hub regista tempos por comando para: `POST /api/v1/agents/commands`, `agents:command` em `/consumers`, e pedidos `relay:rpc.request` (canal `relay`). A escrita e assincrona em lote (`BRIDGE_LATENCY_TRACE_*`), com limite opcional de fila (`BRIDGE_LATENCY_TRACE_MAX_QUEUE`). Retencao: `BRIDGE_LATENCY_TRACE_RETENTION_*` + prune periodico (como auditoria). No shutdown, `flushPendingBridgeLatencyTraces()` drena a fila.

**Amostragem:** `BRIDGE_LATENCY_TRACE_SAMPLE_PERCENT` aplica-se a comandos **bem-sucedidos rapidos**; outcomes `error`, `timeout` e `abort` gravam sempre (quando a sessao de trace existe). `BRIDGE_LATENCY_TRACE_SLOW_TOTAL_MS` (> 0) forca persistencia se `total_ms` for igual ou superior.

**Colunas uteis:** `phases_sum_ms` (soma das fases em `phases_ms`), `phases_schema_version` (versao do conjunto de chaves; hoje 1), `total_ms` (parede). Comparar `phases_sum_ms` com `total_ms` ajuda a detetar fases em falta.

**Prometheus:** `plug_bridge_latency_trace_*` em `GET /metrics` (fila, escritas, drops, `persist_skipped`, `phases_mismatch`, prune). **Nao** expor `conversation_id` ou outros IDs de alta cardinalidade como *labels* Prometheus; correlacao fica na tabela / traces, nao nas series agregadas.

**OpenTelemetry:** `BRIDGE_LATENCY_TRACE_OTEL_ENABLED=true` cria span `bridge.command` por sessao (e necessario tracer configurado na app).

**Privacidade (antes de enfileirar):** `BRIDGE_LATENCY_TRACE_REDACT_USER_ID=true` grava `user_id` como NULL. `BRIDGE_LATENCY_TRACE_TRUNCATE_REQUEST_ID_CHARS` (> 0) corta o `request_id` persistido (reduz vazamento de correlacao em logs/DB).

**Consistencia `total_ms` vs fases:** `BRIDGE_LATENCY_TRACE_PHASES_MISMATCH_WARN_MS` (> 0) incrementa `plug_bridge_latency_trace_phases_mismatch_total` e regista DEBUG quando `|total_ms - phases_sum_ms|` excede o limiar (fases em falta ou relogio).

**Retencao relay:** `BRIDGE_LATENCY_TRACE_RELAY_RETENTION_DAYS` (opcional) aplica-se apenas a linhas com `channel = 'relay'`; se vazio, usa o mesmo prazo que `BRIDGE_LATENCY_TRACE_RETENTION_DAYS`.

### Vista SQL `bridge_latency_trace_hourly_rollups`

Migracao que cria vista (nao materializada) para dashboards SQL/Grafana — agregacao por hora UTC, `channel`, `outcome`, `json_rpc_method`, percentis de `total_ms` e p95 de `agent_to_hub_ms` quando existir em `phases_ms`:

```sql
SELECT * FROM bridge_latency_trace_hourly_rollups
WHERE hour_utc > now() AT TIME ZONE 'UTC' - interval '24 hours'
ORDER BY hour_utc DESC, request_count DESC
LIMIT 50;
```

Exemplo minimo de dashboard Grafana (Prometheus): `docs/grafana/bridge_latency_trace_minimal.json` — apos importar, associa um datasource Prometheus ao painel.

Fases tipicas em `phases_ms` (REST / consumer; relay inclui `consumer_frame_decode_ms`, `relay_preflight_ms`, `relay_forward_to_consumer_ms`, `relay_stream_duration_ms` quando aplicavel):

| Chave | Significado |
| --- | --- |
| `transform_ms` | Paginacao, normalizacao JSON-RPC, atribuicao de `id` no hub |
| `dispatch_preflight_ms` | Validacao, registry, capacidade REST pendente |
| `queue_wait_ms` | Espera na fila por agente (`SOCKET_REST_AGENT_*`) |
| `encode_ms` | `encodePayloadFrameBridge` |
| `emit_to_socket_ms` | `emit` de `rpc:request` |
| `agent_to_hub_ms` | Do fim do emit ate a entrada sincrona do handler `rpc:response` |
| `inbound_decode_ms` | `decodePayloadFrameAsync` |
| `pending_resolve_ms` | Do fim do decode ate `resolve` da promessa REST/socket (inclui merge de stream SQL quando aplicavel) |
| `normalize_ms` | Serializacao HTTP (`normalizeAgentRpcResponse`) |
| `response_write_ms` | `res.json` ou `emit(agents:command_response)` |

Exemplo de analise (percentil aproximado do tempo agente+rede, em ms):

```sql
SELECT
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (phases_ms->>'agent_to_hub_ms')::float)
    AS p95_agent_to_hub_ms
FROM bridge_latency_traces
WHERE created_at > now() - interval '1 hour'
  AND channel = 'rest'
  AND outcome = 'success';
```

Em producao, mantem a amostragem baixa (por exemplo 1–5%) para limitar I/O na base de dados.

### Alertas sugeridos (exemplos)

Ajusta `for` e limiares ao teu tráfego.

```promql
# Relay: chunks descartados por backpressure (deveria ser raro)
rate(plug_socket_relay_chunks_dropped_total[5m]) > 0.1

# Relay: emissões descartadas quando consumer desconecta durante stream
rate(plug_socket_relay_emit_discarded_consumer_gone_total[5m]) > 0

# Relay: conversas expiradas por idle (normal, mas picos podem indicar problema de limpeza)
rate(plug_socket_relay_conversations_expired_total[5m])

# Fila outbound relay: backlog crescente (jobs enfileirados - concluídos)
plug_socket_relay_outbound_queue_backlog > 50

# Fila outbound relay: tails órfãos (jobs zumbis / hung)
plug_socket_relay_outbound_queue_orphaned_request_ids > 0
rate(plug_socket_relay_outbound_queue_orphaned_tails_swept_total[5m]) > 0

# Fila outbound relay: percentil p95 da duração dos jobs acima de limiar
plug_socket_relay_outbound_queue_job_duration_p95_ms > 100

# Fila outbound relay: percentil p99 da duração dos jobs acima de limiar
plug_socket_relay_outbound_queue_job_duration_p99_ms > 200

# Cache de overload stale (refresh parado)
rate(plug_socket_relay_outbound_queue_overload_state_refresh_total[5m]) == 0

# Shed load no namespace /consumers quando a fila relay entra em overload
rate(plug_socket_relay_outbound_queue_overload_rejected_total[5m]) > 0

# Circuito do agente a abrir frequentemente
rate(plug_socket_relay_circuit_open_rejects_total[5m]) > 0.05

# REST bridge: muitas falhas
rate(plug_rest_bridge_requests_failed_total[5m])
  / clamp_min(rate(plug_rest_bridge_requests_total[5m]), 0.001) > 0.15

# Auditoria: eventos descartados por amostragem (esperado se amostragem < 100; em produção o defeito sem env é 25)
rate(plug_socket_audit_writes_sample_skipped_total[5m])

# Bridge latency traces: fila em memoria cheia (perda de amostras)
rate(plug_bridge_latency_trace_writes_dropped_queue_full_total[5m]) > 0

# Bridge latency traces: falhas de escrita persistentes
rate(plug_bridge_latency_trace_writes_failed_total[5m]) > 0.1

# Bridge latency traces: discrepancia total_ms vs soma das fases (definir limiar com PHASES_MISMATCH_WARN_MS)
rate(plug_bridge_latency_trace_phases_mismatch_total[5m]) > 0
```

## Dashboards operacionais sugeridos

Para o relay Socket, um dashboard mínimo útil costuma incluir:

- taxa de `plug_socket_relay_rate_limit_*_rejected_total` por `scope`
- `plug_socket_relay_outbound_queue_backlog`
- `plug_socket_relay_outbound_queue_job_duration_p95_ms`
- `plug_socket_relay_outbound_queue_orphaned_request_ids`
- `rate(plug_socket_relay_emit_discarded_consumer_gone_total[5m])`
- `rate(plug_socket_relay_conversations_expired_total[5m])`
- `rate(plug_socket_relay_outbound_queue_overload_rejected_total[5m])`

## Sinais uteis do relay

### Fila outbound: cleanup de tails órfãos

Cada `requestId` mantem uma cadeia serializada na fila outbound. Se uma cadeia
ficar sem progresso por tempo demais, o hub passa a trata-la como orfa/zumbi e
a remove no sweep periodico:

- `SOCKET_RELAY_OUTBOUND_TAIL_STALE_MS`
- `SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS`

Metricas associadas:

- `plug_socket_relay_outbound_queue_orphaned_request_ids`
- `plug_socket_relay_outbound_queue_orphaned_tails_swept_total`

### Shed load em `/consumers`

Quando a fila outbound relay excede backlog ou latencia p95 configurados, o hub
passa a rejeitar temporariamente novos eventos relay de `/consumers` com
`SERVICE_UNAVAILABLE` e `retryAfterMs`:

- `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG`
- `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS`

Metrica associada:

- `plug_socket_relay_outbound_queue_overload_rejected_total`

### Stream pull: orçamento restante

`relay:rpc.stream.pull_response` agora pode incluir metadados de orçamento da janela:

```json
{
  "success": true,
  "requestId": "req-123",
  "streamId": "stream-123",
  "windowSize": 32,
  "rateLimit": {
    "remainingCredits": 768,
    "limit": 1000,
    "scope": "user"
  }
}
```

Quando bloqueado por limite, o mesmo bloco `rateLimit` acompanha o erro
`RATE_LIMITED`.

Semantica de autorizacao, revogacao e conta ativa no relay:
`docs/client_agent_business_rules.md`.

## Logs e tracing

- O bridge preserva `traceparent` / `tracestate` no `meta` JSON-RPC quando o cliente envia.
- Spans opcionais do bridge: `BRIDGE_LATENCY_TRACE_OTEL_ENABLED` (ver acima). Para tracing geral da app, ver `docs/scaling_and_roadmap.md`.

## Teste de contrato com o repositorio `plug_agente`

Corre `npm run test:contract`. O ficheiro `tests/contract/plug_agente_optional.contract.test.ts` tenta resolver o checkout nesta ordem: variavel `PLUG_AGENTE_ROOT`, pasta irma `../plug_agente` (relativa ao cwd do projeto), ou caminho de desenvolvimento conhecido; se nenhum contiver `docs/communication/openrpc.json`, a suite fica em *skip*.

Opcionalmente forca a raiz:

```bash
set PLUG_AGENTE_ROOT=D:\Developer\plug_database\plug_agente
npm run test:contract
```

Quando o agente e encontrado, a suite valida metodos e versao minima no OpenRPC, existencia dos `schemas/*.json` publicados, compilacao **Ajv** (draft 2020-12) e payloads exemplo cruzados com os validadores Zod do hub.
