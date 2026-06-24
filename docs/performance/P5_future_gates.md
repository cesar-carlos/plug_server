# P5 — Roadmap futuro (gates de métricas)

Itens do plano de desempenho hub ↔ agente que **não** devem ser implementados sem evidência em produção (baseline P0).

## 5.1 Brotli (`br`)

- **Estudo:** [`../studies/brotli_payload_frame_study.md`](../studies/brotli_payload_frame_study.md)
- **Gate:** `plug_socket_relay_bridge_encode_avg_ms` + bytes-on-wire dominam sobre SQL/RTT no baseline
- **Status:** proposed

## 5.2 Escala horizontal (relay state partilhado)

- **Doc:** [`../studies/scaling_and_roadmap.md`](../studies/scaling_and_roadmap.md)
- **Gate:** requisito formal multi-réplica sem sticky sessions
- **Mitigações já disponíveis:** `SOCKET_IO_REDIS_ADAPTER_URL`, `REST_RATE_LIMIT_REDIS_URL`, `AGENT_HUB_PRESENCE_REDIS_URL`
- **Status:** projeto separado

## 5.3 Health poll scheduler

- **Implementado (opcional):** `AGENT_HEALTH_POLL_ENABLED=false` por defeito; ver [ADR 0011](../adrs/0011-health-piggyback.md)
- **Gate para enable:** `plug_agent_health_poll_total` material (>1/min/agente) e piggyback negociado
- **Métricas:** comparar `plug_agent_health_piggyback_used_total` vs `plug_agent_health_poll_total`

## Verificação antes de abrir P5

1. `npm run perf:baseline` com carga representativa
2. Documentar delta na tabela de `performance_hub_agent.md`
3. Só então promover brotli ou scaling para implementação
