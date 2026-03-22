# Observabilidade

## Endpoints

- `GET /metrics` — texto Prometheus (alias util fora do prefixo `/api/v1`).
- `GET /api/v1/metrics` — mesmo payload.

## Metricas uteis (exemplos PromQL)

Ajuste nomes ao scrape target do teu Prometheus. Exemplos genericos:

```promql
# Taxa de pedidos REST ao bridge de agentes (counter real: plug_rest_bridge_requests_total)
rate(plug_rest_bridge_requests_total[5m])

# Sucesso vs falha (cada pedido incrementa `requests_total` uma vez)
rate(plug_rest_bridge_requests_success_total[5m])
rate(plug_rest_bridge_requests_failed_total[5m])

# Fracao de sucesso (~1.0 se estavel); `clamp_min` evita divisao por zero no arranque
rate(plug_rest_bridge_requests_success_total[5m])
  / clamp_min(rate(plug_rest_bridge_requests_total[5m]), 0.001)

# Pulls internos ao materializar stream SQL via REST
rate(plug_rest_sql_stream_materialize_pulls_total[5m])

# Relay: pedidos aceites vs rejeitados por rate-limit
rate(plug_socket_relay_rate_limit_request_allowed_total[5m])
rate(plug_socket_relay_rate_limit_request_rejected_total[5m])

# Socket legado agents:command (mesma janela/max que REST por utilizador; contador separado)
rate(plug_socket_agents_command_rate_limit_allowed_total[5m])
rate(plug_socket_agents_command_rate_limit_rejected_total[5m])
```

Use `GET /metrics` num ambiente de desenvolvimento e copie os nomes exatos dos contadores expostos (podem evoluir com o CHANGELOG).

## Tabela PostgreSQL `bridge_latency_traces` (latencia por fase)

Com `BRIDGE_LATENCY_TRACE_ENABLED=true`, o hub regista tempos por comando para: `POST /api/v1/agents/commands`, `agents:command` em `/consumers`, e pedidos `relay:rpc.request` (canal `relay`). A escrita e assincrona em lote (`BRIDGE_LATENCY_TRACE_*`), com limite opcional de fila (`BRIDGE_LATENCY_TRACE_MAX_QUEUE`). Retencao: `BRIDGE_LATENCY_TRACE_RETENTION_*` + prune periodico (como auditoria). No shutdown, `flushPendingBridgeLatencyTraces()` drena a fila.

**Amostragem:** `BRIDGE_LATENCY_TRACE_SAMPLE_PERCENT` aplica-se a comandos **bem-sucedidos rapidos**; outcomes `error`, `timeout` e `abort` gravam sempre (quando a sessao de trace existe). `BRIDGE_LATENCY_TRACE_SLOW_TOTAL_MS` (> 0) forca persistencia se `total_ms` for igual ou superior.

**Colunas uteis:** `phases_sum_ms` (soma das fases em `phases_ms`), `phases_schema_version` (versao do conjunto de chaves; hoje 1), `total_ms` (parede). Comparar `phases_sum_ms` com `total_ms` ajuda a detetar fases em falta.

**Prometheus:** `plug_bridge_latency_trace_*` em `GET /metrics` (fila, escritas, drops, `persist_skipped`, prune).

**OpenTelemetry:** `BRIDGE_LATENCY_TRACE_OTEL_ENABLED=true` cria span `bridge.command` por sessao (e necessario tracer configurado na app).

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

# Circuito do agente a abrir frequentemente
rate(plug_socket_relay_circuit_open_rejects_total[5m]) > 0.05

# REST bridge: muitas falhas
rate(plug_rest_bridge_requests_failed_total[5m])
  / clamp_min(rate(plug_rest_bridge_requests_total[5m]), 0.001) > 0.15

# Auditoria: eventos descartados por amostragem (esperado se amostragem < 100; em produção o defeito sem env é 25)
rate(plug_socket_audit_writes_sample_skipped_total[5m])
```

## Logs e tracing

- O bridge preserva `traceparent` / `tracestate` no `meta` JSON-RPC quando o cliente envia.
- Spans opcionais do bridge: `BRIDGE_LATENCY_TRACE_OTEL_ENABLED` (ver acima). Para tracing geral da app, ver `docs/scaling_and_roadmap.md`.

## Teste de contrato com o repositorio `plug_agente`

Com o checkout do agente ao lado (ou noutra pasta), define `PLUG_AGENTE_ROOT` e corre:

```bash
set PLUG_AGENTE_ROOT=D:\Developer\plug_database\plug_agente
npm run test:contract
```

Valida presenca de metodos esperados no `openrpc.json` do agente. Para validacao JSON Schema completa, considera integrar AJV num job de CI separado.
