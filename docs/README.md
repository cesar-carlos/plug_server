# Documentacao do `plug_server`

**Papel deste ficheiro:** indice e ordem de leitura. Visao de produto e canais:
`[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)`.

## Como navegar

1. `[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)` — papeis, canais, estado atual.
2. `[api/client_agent_business_rules.md](api/client_agent_business_rules.md)` — ownership / aprovacao.
3. `[api/api_rest_bridge.md](api/api_rest_bridge.md)` — REST + bridge legado `agents:*`.
4. `[socket/socket_relay_protocol.md](socket/socket_relay_protocol.md)` — relay `relay:*`.
5. `[configuration.md](configuration.md)` + `src/shared/config/env.ts` — defaults.

HTTP vivo: OpenAPI em `GET /docs` / `GET /docs.json`. Prefixo canonico `/api/v1`
(aliases `/auth/*`). Metrics: `/metrics` e `/api/v1/metrics` (JWT `role=admin`).

## Inicio rapido

| Doc                                                                        | Para que                |
| -------------------------------------------------------------------------- | ----------------------- |
| `[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)`                               | Mapa do produto         |
| `[api/client_agent_business_rules.md](api/client_agent_business_rules.md)` | User / Agent / Client   |
| `[api/api_rest_bridge.md](api/api_rest_bridge.md)`                         | `POST /agents/commands` |
| `[socket/socket_relay_protocol.md](socket/socket_relay_protocol.md)`       | Contrato relay          |
| `[socket/socket_client_sdk.md](socket/socket_client_sdk.md)`               | Guia pratico Socket     |
| `[configuration.md](configuration.md)`                                     | Env / defaults          |
| `[CHANGELOG.md](../CHANGELOG.md)`                                          | Historico de contrato   |

HTTP vs Socket (resumo): REST cobre API de produto; Socket cobre tempo real
`/consumers` + `/agents`. Detalhe e diagrama: overview.

## Por assunto

### Produto e regras

- `[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)`
- `[api/client_agent_business_rules.md](api/client_agent_business_rules.md)`
- `[api/user_status.md](api/user_status.md)`

### Transporte e integracao

- `[api/api_rest_bridge.md](api/api_rest_bridge.md)`
- `[socket/socket_relay_protocol.md](socket/socket_relay_protocol.md)`
- `[socket/socket_client_sdk.md](socket/socket_client_sdk.md)`
- `[plug_agente/migracao_plug_agente_namespaces.md](plug_agente/migracao_plug_agente_namespaces.md)`
- `[plug_agente/communication_sync_plug_agente.md](plug_agente/communication_sync_plug_agente.md)`

### Operacao

- `[configuration.md](configuration.md)`
- `[limits/limites_acesso_e_quotas.md](limits/limites_acesso_e_quotas.md)` — quotas e 429/503 (fonte de numeros para integradores)
- `[infrastructure/nginx_production.md](infrastructure/nginx_production.md)`
- `[performance/performance_hub_agent.md](performance/performance_hub_agent.md)`
- `[performance/P5_future_gates.md](performance/P5_future_gates.md)` — gates antes de brotli / escala
- `[observability/observability.md](observability/observability.md)`
- `[performance/load_testing.md](performance/load_testing.md)`
- `[performance/e2e_benchmark_hub_agent.md](performance/e2e_benchmark_hub_agent.md)`

### Redis

- `src/infrastructure/redis/README.md` — mapa dos modulos + factories
- `[infrastructure/redis_security.md](infrastructure/redis_security.md)`
- `[infrastructure/redis_streams_agent_backlog.md](infrastructure/redis_streams_agent_backlog.md)`
- Grafana: `[grafana/redis_dashboard.json](grafana/redis_dashboard.json)`,
  `[grafana/relay_batch_dashboard.json](grafana/relay_batch_dashboard.json)`,
  `[grafana/bridge_latency_trace_minimal.json](grafana/bridge_latency_trace_minimal.json)`
- Alertas: `[observability/alerts/redis.yml](observability/alerts/redis.yml)`,
  `[observability/alerts/rate_limits.yml](observability/alerts/rate_limits.yml)`
- `[runbooks/redis_cluster_migration.md](runbooks/redis_cluster_migration.md)`
- `[spikes/_README.md](spikes/_README.md)`
- ADRs Redis: `0001`–`0007`, presence `[0010-agent-hub-presence-redis.md](adrs/0010-agent-hub-presence-redis.md)`

### ADRs de protocolo (relay / agente)

- `[0008-relay-batch-protocol.md](adrs/0008-relay-batch-protocol.md)`
- `[0009-client-request-id-echo.md](adrs/0009-client-request-id-echo.md)`
- `[0011-health-piggyback.md](adrs/0011-health-piggyback.md)`
- `[0012-agent-phase-timings.md](adrs/0012-agent-phase-timings.md)`

### Roadmap e estudos

- `[studies/scaling_and_roadmap.md](studies/scaling_and_roadmap.md)`
- `[studies/relay_fastpath_study.md](studies/relay_fastpath_study.md)` (historico)
- `[studies/db_partitioning_study.md](studies/db_partitioning_study.md)`
- `[studies/brotli_payload_frame_study.md](studies/brotli_payload_frame_study.md)` (proposta; gates em P5)

### plug_agente (coordenacao cross-repo)

- `[plug_agente/README.md](plug_agente/README.md)` — **status vivo**
- `[plug_agente/communication_sync_plug_agente.md](plug_agente/communication_sync_plug_agente.md)`
- `[plug_agente/migracao_plug_agente_namespaces.md](plug_agente/migracao_plug_agente_namespaces.md)`
- `[plug_agente/01_relay_body_id_echo.md](plug_agente/01_relay_body_id_echo.md)` — historico Opcao B/A
- `[plug_agente/02_no_change_items.md](plug_agente/02_no_change_items.md)`
- `[plug_agente/03_performance_roadmap.md](plug_agente/03_performance_roadmap.md)` — arquivo
- `[plug_agente/04_agent_implementation_status.md](plug_agente/04_agent_implementation_status.md)` — ledger
- `[plug_agente/05_channel_migration_performance.md](plug_agente/05_channel_migration_performance.md)`

### Runbooks

- `[runbooks/redis_cluster_migration.md](runbooks/redis_cluster_migration.md)`
- `[runbooks/socket_perf_investigation.md](runbooks/socket_perf_investigation.md)`
- `[runbooks/payload_signing_key_rotation_runbook.md](runbooks/payload_signing_key_rotation_runbook.md)`

## Papel de cada documento (resumo)

| Doc                                                            | Papel                                   |
| -------------------------------------------------------------- | --------------------------------------- |
| `PROJECT_OVERVIEW`                                             | Visao executiva                         |
| `client_agent_business_rules`                                  | Regras de negocio                       |
| `api_rest_bridge`                                              | Contrato REST + `agents:*`              |
| `socket_relay_protocol`                                        | Contrato relay                          |
| `socket_client_sdk`                                            | Guia (nao normativo completo)           |
| `configuration` + `env.ts`                                     | Config                                  |
| `limites_acesso_e_quotas`                                      | Quotas / respostas ao atingir limites   |
| `observability` / `performance_hub_agent` / `nginx_production` | Operacao                                |
| `studies/*` / `spikes/*` / ADRs                                | Nao normativo / decisoes / experimentos |
