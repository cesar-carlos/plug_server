# Documentacao do `plug_server`

## Como navegar

Use os documentos nesta ordem:

1. `docs/PROJECT_OVERVIEW.md` para entender papeis, canais e limites do hub.
2. `docs/client_agent_business_rules.md` para ownership, aprovacao, autorizacao e revogacao.
3. `docs/api_rest_bridge.md` para o contrato HTTP e o bridge legado `agents:*`.
4. `docs/socket_relay_protocol.md` para o contrato relay `relay:*` em `/consumers`.
5. `docs/configuration.md` e `src/shared/config/env.ts` para defaults, parsing e variaveis.

Para rotas HTTP, a referencia viva e o OpenAPI exposto em `GET /docs` e `GET /docs.json`.
Os caminhos canonicos usam prefixo `/api/v1`, com excecao dos aliases de compatibilidade
`/auth/*` e `/metrics`.

## Inicio rapido

- `docs/PROJECT_OVERVIEW.md`: mapa do produto, dos namespaces Socket e dos canais REST.
- `docs/client_agent_business_rules.md`: regra oficial do modelo `User` / `Agent` / `Client`.
- `docs/api_rest_bridge.md`: `POST /api/v1/agents/commands`, respostas normalizadas, `Retry-After` e offline bridge.
- `docs/socket_relay_protocol.md`: contrato relay em `/consumers`.
- `docs/socket_client_sdk.md`: guia pratico para consumidor Socket.
- `docs/configuration.md`: checklist de ambiente, defaults e links para `env.ts` / `.env.example`.
- `CHANGELOG.md`: historico de mudancas que afetam contrato e operacao.

## Por assunto

### Produto e regras

- `docs/PROJECT_OVERVIEW.md`
- `docs/client_agent_business_rules.md`
- `docs/user_status.md`

### Transporte e integracao

- `docs/api_rest_bridge.md`
- `docs/socket_relay_protocol.md`
- `docs/socket_client_sdk.md`
- `docs/migracao_plug_agente_namespaces.md`
- `docs/communication_sync_plug_agente.md`

### Operacao

- `docs/configuration.md`
- `docs/nginx_production.md`
- `docs/performance_hub_agent.md`
- `docs/observability.md`
- `docs/load_testing.md`
- `docs/e2e_benchmark_hub_agent.md`

### Roadmap e estudos

- `docs/scaling_and_roadmap.md`
- `docs/relay_fastpath_study.md`
- `docs/db_partitioning_study.md`

## Papel de cada documento

- `PROJECT_OVERVIEW.md`: visao executiva e mapa conceitual.
- `client_agent_business_rules.md`: fonte canonica das regras de negocio.
- `api_rest_bridge.md`: contrato REST e `agents:command`.
- `socket_relay_protocol.md`: contrato relay e PayloadFrame no consumidor.
- `socket_client_sdk.md`: guia de implementacao, sem repetir o contrato completo.
- `configuration.md`: fonte narrativa de configuracao; defaults formais vivem em `env.ts`.
- `observability.md`, `performance_hub_agent.md`, `nginx_production.md`: operacao.
- `scaling_and_roadmap.md`, `relay_fastpath_study.md`, `db_partitioning_study.md`: material nao normativo.
