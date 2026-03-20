# Configuracao

## Fonte de verdade para defaults

- **Variaveis**: valores por defeito e parsing em [`src/shared/config/env.ts`](../src/shared/config/env.ts) (Zod `.default()`).
- **Exemplo local**: [`.env.example`](../.env.example) (copiar para `.env`).
- **Documentacao narrativa**: `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md`, `docs/performance_hub_agent.md`.

Evite duplicar numeros em varios sitios sem atualizar `env.ts`; quando duvidar, confira o ficheiro de env ou `.env.example`.

## Leitura recomendada

| Topico | Documento |
| ------ | --------- |
| REST bridge, timeouts, rate limit | `docs/api_rest_bridge.md` |
| Relay Socket, quotas | `docs/socket_relay_protocol.md` |
| Throughput hub ↔ agente | `docs/performance_hub_agent.md` |
| Metricas e paineis | `docs/observability.md` |
| SSE, Redis, multi-instancia, OTel | `docs/scaling_and_roadmap.md` |
