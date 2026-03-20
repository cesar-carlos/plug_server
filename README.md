# plug_server

API backend em TypeScript com Express e Socket.IO.

O **consumer** pode enviar comandos ao `plug_agente` por **dois canais**: **REST**
(`POST /api/v1/agents/commands`) ou **Socket.IO** no namespace `/consumers`
(`agents:command`, relay `relay:*`, etc.). O mesmo JSON-RPC é aceite nos dois;
o REST **não** expõe streaming progressivo (o hub agrega o resultado num único
JSON). Para chunks em tempo real e backpressure, usar Socket. O **agente**
liga-se sempre ao hub em `/agents`. Resumo e tabela em
[docs/project_overview.md](./docs/project_overview.md) (*Dois canais para comandos ao agente*).

## Stack

- Node.js + TypeScript
- Express (REST)
- Socket.IO (tempo real)
- Zod (validacao)
- JWT access + refresh token rotation
- Vitest + Supertest

## Documentacao e historico

- [docs/project_overview.md](./docs/project_overview.md) — visão geral, papéis, REST vs Socket, eventos
- [docs/configuration.md](./docs/configuration.md) — onde estão os defaults (`env.ts`, `.env.example`)
- [CHANGELOG.md](./CHANGELOG.md) — mudancas, migracao e roadmap tecnico
- [docs/api_rest_bridge.md](./docs/api_rest_bridge.md) — `POST /agents/commands` e canal legado `agents:*`
- [docs/socket_client_sdk.md](./docs/socket_client_sdk.md) — relay `PayloadFrame`, `agents:command`, exemplos
- [docs/socket_relay_protocol.md](./docs/socket_relay_protocol.md) — contrato relay (`relay:*`), quotas e metricas
- [docs/performance_hub_agent.md](./docs/performance_hub_agent.md) — tuning hub ↔ agente
- [docs/observability.md](./docs/observability.md) — métricas, `test:contract`, tracing, exemplos de alertas
- [docs/load_testing.md](./docs/load_testing.md) — notas para carga HTTP/Socket
- [docs/scaling_and_roadmap.md](./docs/scaling_and_roadmap.md) — multi-instância, SSE, OpenTelemetry, SDK

## Scripts

- `npm run dev` - desenvolvimento
- `npm run typecheck` - checagem de tipos
- `npm run lint` - lint
- `npm run test` - testes
- `npm run build` - build de producao

