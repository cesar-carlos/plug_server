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
- JWT access + refresh token rotation; contas `blocked`, bloqueio admin, `PATCH /auth/me` (celular) e métricas em [docs/user_status.md](./docs/user_status.md)
- Vitest + Supertest

## Documentacao e historico

- [docs/PROJECT_OVERVIEW.md](./docs/PROJECT_OVERVIEW.md) — visão geral, papéis, canais e arquitetura
- [docs/configuration.md](./docs/configuration.md) — onde estão os defaults (`env.ts`, `.env.example`)
- [CHANGELOG.md](./CHANGELOG.md) — mudancas, migracao e roadmap tecnico
- [docs/api_rest_bridge.md](./docs/api_rest_bridge.md) — `POST /api/v1/agents/commands` e canal legado `agents:*`
- [docs/socket_client_sdk.md](./docs/socket_client_sdk.md) — relay `PayloadFrame`, `agents:command`, exemplos
- [docs/socket_relay_protocol.md](./docs/socket_relay_protocol.md) — contrato relay (`relay:*`), quotas e metricas
- [docs/performance_hub_agent.md](./docs/performance_hub_agent.md) — tuning hub ↔ agente (presets `.env` + checklist)
- [docs/observability.md](./docs/observability.md) — métricas, `test:contract`, tracing, exemplos de alertas (incl. `plug_auth_*`, `plug_admin_user_status_set_total`)
- [docs/user_status.md](./docs/user_status.md) — estados da conta (`pending`, `active`, `rejected`, `blocked`), API admin e métricas Prometheus
- [docs/load_testing.md](./docs/load_testing.md) — notas para carga HTTP/Socket
- [docs/scaling_and_roadmap.md](./docs/scaling_and_roadmap.md) — multi-instância, SSE, OpenTelemetry, SDK

## Scripts

- `npm run dev` - desenvolvimento
- `npm run typecheck` - checagem de tipos
- `npm run lint` - lint
- `npm run test` - testes (unit/integration/contract; e2e excluídos)
- `npm run test:e2e` - Vitest e2e (HTTP + Socket.IO). Com `E2E_TESTS_ENABLED=true` no `.env` e `DATABASE_URL` acessível (ver `.env.example`); se estiver desligado, termina com exit 0 sem correr a suíte. Pode ser invocado no CI após `npm run test` (idempotente quando desligado).
- `npm run build` - build de producao

