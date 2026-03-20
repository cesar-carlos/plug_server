# Observabilidade

## Endpoints

- `GET /metrics` — texto Prometheus (alias util fora do prefixo `/api/v1`).
- `GET /api/v1/metrics` — mesmo payload.

## Metricas uteis (exemplos PromQL)

Ajuste nomes ao scrape target do teu Prometheus. Exemplos genericos:

```promql
# Taxa de pedidos REST ao bridge de agentes (se exposto como counter)
rate(plug_rest_agent_commands_requests_total[5m])

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

# Auditoria: eventos descartados por amostragem (esperado se SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT < 100)
rate(plug_socket_audit_writes_sample_skipped_total[5m])
```

## Logs e tracing

- O bridge preserva `traceparent` / `tracestate` no `meta` JSON-RPC quando o cliente envia.
- Para **OpenTelemetry** (traces exportados para Jaeger/Tempo/etc.), ver `docs/scaling_and_roadmap.md` — nao vem ativado por defeito neste servico.

## Teste de contrato com o repositorio `plug_agente`

Com o checkout do agente ao lado (ou noutra pasta), define `PLUG_AGENTE_ROOT` e corre:

```bash
set PLUG_AGENTE_ROOT=D:\Developer\plug_database\plug_agente
npm run test:contract
```

Valida presenca de metodos esperados no `openrpc.json` do agente. Para validacao JSON Schema completa, considera integrar AJV num job de CI separado.
