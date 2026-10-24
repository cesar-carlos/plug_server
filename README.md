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

- Node.js 24 + TypeScript
- Express (REST)
- Socket.IO (tempo real)
- Zod (validacao)
- JWT access + refresh token rotation; contas `blocked`, bloqueio admin, `PATCH /auth/me` (celular) e métricas em [docs/api/user_status.md](./docs/api/user_status.md)
- Vitest + Supertest

## Documentacao e historico

- [Índice da documentação](docs/README.md) — contratos, configuração, operação e integração com o agente.
- [Visão geral](docs/PROJECT_OVERVIEW.md) — papéis, canais e arquitetura.
- [Histórico de alterações](CHANGELOG.md).
- [Regras do projeto](AGENTS.md) — entrada para as regras em `.cursor/rules`.

## Scripts

- `npm run dev` - desenvolvimento
- `npm run typecheck` - checagem de tipos
- `npm run lint` - lint
- `npm run contract:generate` / `contract:check` - gera e confere o contrato REST consumido pelo MCP; o check protege rotas/status, requests e respostas contra remoção ou estreitamento silencioso
- `npm run release:check` - gate local: formato, lint, tipos, contrato, testes e build
- `npm run test` - testes (unit/integration/contract; e2e excluídos)
- `npm run test:access-flow` - regressão focada no fluxo cliente→agente (pedido, inbox owner, rotas `/client-access/*`, unitário do serviço); útil antes de deploy ou após alterações nessa área
- `npm run test:e2e` - Vitest e2e (HTTP + Socket.IO), só local. Com `E2E_TESTS_ENABLED=true` no `.env` e `DATABASE_URL` acessível (ver `.env.example`); se estiver desligado, termina com exit 0 sem correr a suíte. Não há workflow E2E no GitHub Actions.
- `npm run build` - build de producao

## Client-access e base de dados (produção)

- Manter a **mesma versão** da API em todos os nós.
- Configurar `DATABASE_URL` para transações interativas do Prisma (poolers tipo PgBouncer em modo inadequado podem falhar nas operações atómicas de aprovação/recusa).
- Em falhas ao aprovar ou recusar, a API pode responder **503**; consultar logs estruturados `client_agent_access_txn_failed` e `client_agent_access_txn_prisma_error` (ver também [docs/observability/observability.md](./docs/observability/observability.md)).
- Detalhes adicionais em `.env.example` junto a `DATABASE_URL`.
- Para regressão E2E opcional do link público (review HTML + POST approve), ativar `E2E_TESTS_ENABLED=true` e correr `npm run test:e2e` (ficheiro `tests/e2e/flows/client_access_public_token.e2e.test.ts`).
