# plug_server

API backend em TypeScript com Express e Socket.IO.

O **consumer** pode enviar comandos ao `plug_agente` por **dois canais**: **REST**
(`POST /api/v1/agents/commands`) ou **Socket.IO** no namespace `/consumers`
(`agents:command`, relay `relay:*`, etc.). O mesmo JSON-RPC é aceite nos dois;
o REST **não** expõe streaming progressivo (o hub agrega o resultado num único
JSON). Para chunks em tempo real e backpressure, usar Socket. O **agente**
liga-se sempre ao hub em `/agents`. Resumo e tabela em
[docs/PROJECT_OVERVIEW.md](./docs/PROJECT_OVERVIEW.md) (*Canais de comunicacao*).

## Stack

- Node.js + TypeScript
- Express (REST)
- Socket.IO (tempo real)
- Zod (validacao)
- JWT access + refresh token rotation; contas `blocked`, bloqueio admin, `PATCH /auth/me` (celular) e métricas em [docs/api/user_status.md](./docs/api/user_status.md)
- Vitest + Supertest

## Documentacao e historico

- [docs/README.md](./docs/README.md) — índice e ordem de leitura
- [docs/PROJECT_OVERVIEW.md](./docs/PROJECT_OVERVIEW.md) — visão geral, papéis, canais e arquitetura
- [docs/configuration.md](./docs/configuration.md) — onde estão os defaults (`env.ts`, `.env.example`)
- [docs/infrastructure/nginx_production.md](./docs/infrastructure/nginx_production.md) — ajustes de Nginx para produção (API, Socket.IO e uploads)
- [CHANGELOG.md](./CHANGELOG.md) — mudancas, migracao e roadmap tecnico
- [docs/api/api_rest_bridge.md](./docs/api/api_rest_bridge.md) — `POST /api/v1/agents/commands` e canal legado `agents:*`
- [docs/socket/socket_client_sdk.md](./docs/socket/socket_client_sdk.md) — relay `PayloadFrame`, `agents:command`, exemplos
- [docs/socket/socket_relay_protocol.md](./docs/socket/socket_relay_protocol.md) — contrato relay (`relay:*`), quotas e metricas
- [docs/performance/performance_hub_agent.md](./docs/performance/performance_hub_agent.md) — tuning hub ↔ agente (presets `.env` + checklist)
- [docs/observability/observability.md](./docs/observability/observability.md) — métricas, `test:contract`, tracing, exemplos de alertas (incl. `plug_auth_*`, `plug_admin_user_status_set_total`)
- [docs/api/user_status.md](./docs/api/user_status.md) — estados da conta (`pending`, `active`, `rejected`, `blocked`), API admin e métricas Prometheus
- [docs/performance/load_testing.md](./docs/performance/load_testing.md) — notas para carga HTTP/Socket
- [docs/studies/scaling_and_roadmap.md](./docs/studies/scaling_and_roadmap.md) — multi-instância, SSE, OpenTelemetry, SDK
- [docs/api/client_agent_business_rules.md](./docs/api/client_agent_business_rules.md) — regras User / Agent / Client; `GET /api/v1/client/me/agents` e `GET /api/v1/client/me/agents/{agentId}` expõem `isHubConnected` (ligado a **este** processo do hub após `agent:register` no Socket `/agents`; contrato em `GET /docs.json`, componente `ClientAccessibleAgent`). Opcional: `HUB_INSTANCE_ID` no `.env` envia o header `X-Hub-Instance-Id`; métricas `plug_client_me_agents_*` em `GET /metrics` (ver `docs/observability/observability.md`)

## Scripts

- `npm run dev` - desenvolvimento
- `npm run typecheck` - checagem de tipos
- `npm run lint` - lint
- `npm run test` - testes (unit/integration/contract; e2e excluídos)
- `npm run test:access-flow` - regressão focada no fluxo cliente→agente (pedido, inbox owner, rotas `/client-access/*`, unitário do serviço); útil antes de deploy ou após alterações nessa área
- `npm run test:e2e` - Vitest e2e (HTTP + Socket.IO). Com `E2E_TESTS_ENABLED=true` no `.env` e `DATABASE_URL` acessível (ver `.env.example`); se estiver desligado, termina com exit 0 sem correr a suíte. Pode ser invocado no CI após `npm run test` (idempotente quando desligado).
- `npm run build` - build de producao

## Client-access e base de dados (produção)

- Manter a **mesma versão** da API em todos os nós.
- Configurar `DATABASE_URL` para transações interativas do Prisma (poolers tipo PgBouncer em modo inadequado podem falhar nas operações atómicas de aprovação/recusa).
- Em falhas ao aprovar ou recusar, a API pode responder **503**; consultar logs estruturados `client_agent_access_txn_failed` e `client_agent_access_txn_prisma_error` (ver também [docs/observability/observability.md](./docs/observability/observability.md)).
- Detalhes adicionais em `.env.example` junto a `DATABASE_URL`.
- Para regressão E2E opcional do link público (review HTML + POST approve), ativar `E2E_TESTS_ENABLED=true` e correr `npm run test:e2e` (ficheiro `tests/e2e/flows/client_access_public_token.e2e.test.ts`).

