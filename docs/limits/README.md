# Limites de acesso e quotas

Documentação orientada a **integradores e operadores** sobre tetos de tráfego, filas e respostas quando um limite é atingido.

| Documento | Conteúdo |
| --------- | -------- |
| [limites_acesso_e_quotas.md](limites_acesso_e_quotas.md) | Referência completa: HTTP, Nginx, Socket, login, formatos de erro e métricas |

## Relacionado

- [`docs/configuration.md`](../configuration.md) — variáveis de ambiente e defaults formais (`env.ts`)
- [`docs/infrastructure/nginx_production.md`](../infrastructure/nginx_production.md) — rate limit na borda e deploy Nginx
- [`docs/api/api_rest_bridge.md`](../api/api_rest_bridge.md) — `Retry-After` em erros RPC do agente (`-32013`)
- [`docs/api/client_agent_business_rules.md`](../api/client_agent_business_rules.md) — regras de negócio (acesso, revogação, retries de pedido)
- [`docs/observability/alerts/rate_limits.yml`](../observability/alerts/rate_limits.yml) — alertas Prometheus para rejeições 429 sustentadas

## Fonte de verdade para números

1. Valores **em produção**: ficheiro `.env` do servidor (podem divergir dos defaults).
2. Valores **por defeito do código**: [`src/shared/config/env.ts`](../../src/shared/config/env.ts).
3. Exemplo de perfil dashboard: [`.env.example`](../../.env.example) (alinhado ao HTTP global 2 min, credenciais 5 min, commands 200/min).

Quando esta documentação e o `.env` divergirem, **prevalece o `.env` activo** após restart do processo.

Tabela resumida do perfil actual: secção **Perfil de produção activo** em [`limites_acesso_e_quotas.md`](limites_acesso_e_quotas.md).
