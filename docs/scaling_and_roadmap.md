# Escala, SSE e integracoes futuras

Este documento consolida melhorias sugeridas que **nao** estao implementadas de forma completa no `plug_server`, para orientar roadmap e operacao.

**Principio:** o desenho alvo e extrair o maximo de desempenho e fiabilidade **com as dependencias ja declaradas no repositorio** (Node, Express, Socket.IO, Prisma, etc.). Presenca de agente em REST (`isHubConnected`) e o `agentRegistry` em memoria **nao** pressupoem Redis nem outros pacotes novos; em multi-instancia, a estrategia suportada e afinidade de sessao / mesma base URL e header opcional `HUB_INSTANCE_ID` (ver `docs/client_agent_business_rules.md`). Itens abaixo como Redis ou OTel sao **evolucoes opcionais** de roadmap, nao requisitos para o contrato actual.

## Multi-instancia HTTP / estado em memoria

O bridge REST e parte do relay mantem **correlacao e filas em memoria** por processo. Varias replicas sem afinidade de sessao ou store partilhado podem perder pedidos pendentes ou duplicar comportamento estranho. Num **unico** processo, afina primeiro throughput com os presets em `docs/performance_hub_agent.md` antes de investir em store partilhado.

Estado explicitamente **por processo** hoje:

- `conversationRegistry` (conversas relay e idle timeout)
- pending requests REST/legacy socket
- rooms Socket.IO (`client:<id>`, `consumer:principal:*`)
- `agentRegistry` e readiness/circuit local
- mapa de idempotencia relay
- filas outbound hub -> consumer e buffers de stream

Consequencia pratica: em producao, `/consumers` e `/agents` precisam de **sticky
sessions** (ou topologia equivalente que garanta afinidade) para que o mesmo
cliente/agent voltem ao processo que detem esse estado.

### Rate limits HTTP em memoria (`express-rate-limit`)

Todos os limitadores HTTP (`globalRateLimit`, `credentialAuthRateLimit`, `agentsCommandsUserRateLimit`, `agentsCommandsIpRateLimit`, `adminUserStatusRateLimit`, `clientMeAgentsPostRateLimit`, `clientThumbnailRateLimit`, `clientPasswordRecoveryRequestRateLimit`, `agentsSelfProfileRateLimit`) usam o **store default em memoria** do `express-rate-limit`. Em multi-replica:

- cada pod tem o seu balde, logo o **limite efetivo** se multiplica pelo numero de replicas;
- nao ha coordenacao para detetar abuso distribuido por trás de balanceador;
- recoveries / restarts zeram a janela para todas as IPs.

**Mitigacoes ja em produção:**
- `HTTP_TRUST_PROXY=true` faz `req.ip` refletir o cliente real atras de Nginx;
- chaves dos limitadores autenticados usam `JWT sub`, nao IP, o que continua funcional cross-replica para o **mesmo usuario** (o teto e por usuario, mas multiplicado pelo numero de pods que o usuario alcanca);
- `Retry-After` e `RateLimit-*` headers continuam corretos por replica.

**Caminho de evolucao:** quando justificar, adotar um `Store` Redis (`rate-limit-redis`) compartilhado. Manter fail-open quando o Redis cair (politica conservadora: se store indisponivel, deixar passar e logar) para evitar transformar uma falha de cache num corte total de API. Ate la, o desenho assume **sticky sessions** ou um numero de replicas baixo o suficiente para que a multiplicacao do teto seja aceitavel.

Importante: jobs de manutencao **ja** estao coordenados por advisory lock
(prune de `audit_events`, prune de `bridge_latency_traces`, manutencao de
perfil de agente, sweep de expiracao `client_agent_access` e prune de dead
letters do outbox). Ou seja: multi-instancia continua delicado para estado em
memoria do bridge/relay, mas **nao** duplica mais o trabalho dos schedulers de
retencao/prune.

**Caminhos possiveis:**

1. **Uma instancia** ou **sticky sessions** ao mesmo processo que trata o Socket do agente.
2. **Redis** (ou similar) para pending requests, idempotencia estendida e eventualmente pub/sub entre replicas — requer desenho cuidadoso de chaves e TTL.

Ver tambem a checklist em `docs/api_rest_bridge.md` (gaps / replicas).

## Streaming progressivo no REST (SSE ou chunked)

Hoje o `POST /api/v1/agents/commands` **materializa** resultados com `stream_id` num unico JSON. **Server-Sent Events** ou resposta HTTP chunked com JSON por linha seria um **novo contrato** publico (documentacao, clientes, testes, possivel negociacao por header `Accept`).

Recomendacao: manter Socket para baixa latencia por chunk ate haver requisito firme de cliente apenas HTTP.

## OpenTelemetry

O servico nao inclui SDK OTel por defeito. Integracao tipica:

- `instrumentation-http` + `instrumentation-express` para spans HTTP.
- Propagacao `traceparent` ja suportada no payload JSON-RPC; alinhar com o propagator W3C no middleware.

## Cliente / SDK

Um pacote npm partilhado (encode `PayloadFrame`, politica gzip **auto**) reduz copia de codigo entre apps. Referencia minima em [`docs/snippets/payload_frame_client_encode.ts`](snippets/payload_frame_client_encode.ts) e em `docs/socket_client_sdk.md`.
