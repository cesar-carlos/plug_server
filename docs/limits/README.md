# Limites de acesso e quotas

Documentação orientada a **integradores e operadores** sobre tetos de tráfego, filas e respostas quando um limite é atingido.

| Documento | Conteúdo |
| --------- | -------- |
| [limites_acesso_e_quotas.md](limites_acesso_e_quotas.md) | Referência completa: HTTP, Nginx, Socket, login, formatos de erro e métricas |

## Relacionado

- [`docs/configuration.md`](../configuration.md) — variáveis de ambiente e defaults formais (`env.ts`)
- [`docs/nginx_production.md`](../nginx_production.md) — rate limit na borda e deploy Nginx
- [`docs/api_rest_bridge.md`](../api_rest_bridge.md) — `Retry-After` em erros RPC do agente (`-32013`)
- [`docs/client_agent_business_rules.md`](../client_agent_business_rules.md) — regras de negócio (acesso, revogação, retries de pedido)
- [`docs/observability/alerts/rate_limits.yml`](../observability/alerts/rate_limits.yml) — alertas Prometheus para rejeições 429 sustentadas

## Fonte de verdade para números

1. Valores **em produção**: ficheiro `.env` do servidor (podem divergir dos defaults).
2. Valores **por defeito do código**: [`src/shared/config/env.ts`](../../src/shared/config/env.ts).
3. Exemplo local: [`.env.example`](../../.env.example).

Quando esta documentação e o `.env` divergirem, **prevalece o `.env` activo** após restart do processo.
