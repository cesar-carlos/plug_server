# Escala, SSE e integracoes futuras

Este documento consolida melhorias sugeridas que **nao** estao implementadas de forma completa no `plug_server`, para orientar roadmap e operacao.

**Principio:** o desenho alvo e extrair o maximo de desempenho e fiabilidade **com as dependencias ja declaradas no repositorio** (Node, Express, Socket.IO, Prisma, etc.). Presenca de agente em REST (`isHubConnected`) e o `agentRegistry` em memoria **nao** pressupoem Redis nem outros pacotes novos; em multi-instancia, a estrategia suportada e afinidade de sessao / mesma base URL e header opcional `HUB_INSTANCE_ID` (ver `docs/client_agent_business_rules.md`). Redis ja e suportado como opcional para rate limits HTTP e Socket; outros itens abaixo, como OTel ou stores partilhados do bridge/relay, seguem como evolucoes opcionais de roadmap.

## Multi-instancia HTTP / estado em memoria

O bridge REST e parte do relay mantem **correlacao e filas em memoria** por processo. Varias replicas sem afinidade de sessao ou store partilhado podem perder pedidos pendentes ou duplicar comportamento estranho. Num **unico** processo, afina primeiro throughput com os presets em `docs/performance_hub_agent.md` antes de investir em store partilhado.

Estado explicitamente **por processo** hoje:

- `conversationRegistry` (conversas relay e idle timeout)
- pending requests REST/legacy socket
- rooms Socket.IO (`client:<id>`, `consumer:principal:*`)
- rooms de pub/sub customizado (`client:custom.*` assinado via `socket:event.subscribe`)
- estado em memoria do limitador `socket:event.publish` (`client_socket_event_publish_socket_rate_limiter`; Redis opcional com scope `client_socket_event_publish`, chave de identidade `client:<JWT sub do Client>`)
- `agentRegistry` e readiness/circuit local
- mapa de idempotencia relay
- filas outbound hub -> consumer e buffers de stream
- fila relay por agente (`SOCKET_RELAY_AGENT_*`)

Consequencia pratica: em producao, `/consumers` e `/agents` precisam de **sticky
sessions** (ou topologia equivalente que garanta afinidade) para que o mesmo
cliente/agent voltem ao processo que detem esse estado.

### Rate limits HTTP (`express-rate-limit`)

Todos os limitadores HTTP (`globalRateLimit`, `credentialAuthRateLimit`, `agentsCommandsUserRateLimit`, `agentsCommandsIpRateLimit`, `adminUserStatusRateLimit`, `clientMeAgentsPostRateLimit`, `clientSocketEventPublishRateLimit`, `clientThumbnailRateLimit`, `clientPasswordRecoveryRequestRateLimit`, `agentsSelfProfileRateLimit`) usam o **store default em memoria** do `express-rate-limit` quando `REST_RATE_LIMIT_REDIS_URL` esta vazio. Em multi-replica sem Redis:

- cada pod tem o seu balde, logo o **limite efetivo** se multiplica pelo numero de replicas;
- nao ha coordenacao para detetar abuso distribuido por trás de balanceador;
- recoveries / restarts zeram a janela para todas as IPs.

**Mitigacoes ja em produção:**
- `HTTP_TRUST_PROXY=true` faz `req.ip` refletir o cliente real atras de Nginx;
- `REST_RATE_LIMIT_REDIS_URL` opcional: quando definido, os limitadores HTTP `express-rate-limit` usam Redis (`rate-limit-redis`) para estado partilhado entre replicas, com prefixo isolado por limitador; vazio mantem store em memoria por processo (comportamento anterior). Falha na ligacao: log `rest_rate_limit_redis_fallback_memory`, metrica Prometheus `plug_rest_http_rate_limit_redis_fallback_events_total`, store em memoria. Falha runtime do store Redis: `passOnStoreError=true`, log `rest_rate_limit_redis_command_error`, request permitido sem rate-limit distribuido, metricas `plug_rest_http_rate_limit_redis_runtime_command_errors_total` / `plug_rest_http_rate_limit_redis_fallback_events_total` incrementadas. Apos erros consecutivos, o circuito Redis abre temporariamente (`plug_rest_http_rate_limit_redis_circuit_open=1`) para reduzir latencia em cascata;
- exemplo de chave Redis para `clientSocketEventPublishRateLimit`: `plug_rl:client_socket_event_publish:client:<JWT sub>` (o sufixo e o valor devolvido por `clientSocketEventPublishRateLimitKey` em `rate_limit.middleware.ts`);
- chaves dos limitadores autenticados usam `JWT sub`, nao IP, o que continua funcional para o **mesmo usuario**; com Redis, o teto e partilhado entre replicas, e sem Redis o teto se multiplica pelo numero de pods que o usuario alcanca;
- `Retry-After` e `RateLimit-*` headers continuam corretos para o store efetivamente usado.

### Rate limits Socket

`SOCKET_RATE_LIMIT_REDIS_URL` distribui os limitadores de `agents:command`,
`agents:stream_pull`, `relay:conversation.start`, `relay:rpc.request`, creditos
de `relay:rpc.stream.pull`, `agent:register` e `socket:event.publish` (`client_socket_event_publish`; chave Redis por cliente `client:<JWT sub>` dentro desse scope). O comportamento e fail-open:
queda/conexao instavel no Redis registra `plug_socket_rate_limit_redis_*` e o
hub volta ao limiter local em memoria.

Isso **nao** torna o Socket stateless. Conversas, pending requests, streams,
idempotencia relay, registry do agente e filas por agente continuam por processo.
Portanto sticky sessions seguem obrigatorias para `/consumers` e `/agents`.

O pub/sub customizado (`POST /api/v1/client/me/socket-events` ou `socket:event.publish`
para `client:custom.*`) tambem e local ao processo quando nao ha adapter
distribuido do Socket.IO. `recipients` conta somente sockets inscritos na mesma
replica que recebeu o pedido. A idempotencia via `Idempotency-Key` (REST) ou `idempotencyKey` (Socket) tambem e cache
em memoria por processo; em multi-replica, retries precisam cair na mesma
replica para reaproveitar a resposta sem nova emissao. Use
`REST_SOCKET_EVENT_MAX_RECIPIENTS` para proteger fan-out local em picos.

**Proximos passos:** manter fail-open quando o Redis cair (politica conservadora: se store indisponivel, deixar passar e logar) para evitar transformar uma falha de cache num corte total de API. Para estado do bridge/relay Socket, o desenho ainda assume **sticky sessions** ou um numero de replicas baixo o suficiente para que o estado em memoria continue aceitavel.

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
