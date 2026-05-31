# Escala, SSE e integracoes futuras

Este documento consolida o estado de escala do `plug_server`: o que ja e suportado,
o que ainda depende de sticky sessions e o que permanece como roadmap.

**Principio:** o desenho alvo e extrair o maximo de desempenho e fiabilidade **com
as dependencias declaradas no repositorio** (Node, Express, Socket.IO, Prisma,
Redis opcional, etc.). Redis ja e suportado para rate limits HTTP/Socket, adapter
distribuido do Socket.IO (`SOCKET_IO_REDIS_ADAPTER_URL`) e idempotencia distribuida
de `client:custom.*` (`REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL`). Com
`SOCKET_IO_REDIS_ADAPTER_URL` (ou `AGENT_HUB_PRESENCE_REDIS_URL`), presenca de
agente e forward de `POST /api/v1/agents/commands` podem atravessar replicas
(ADR-0010) — codigo de suporte, nao o perfil de deploy deste repositorio.
**Producao:** um unico processo (`deploy/pm2/ecosystem.config.cjs`, porta 4000).
Conversas relay, pending requests REST e grande parte do relay seguem em memoria
por processo. Defina `HUB_INSTANCE_ID` para observabilidade (`docs/configuration.md`).

## Multi-instancia HTTP / estado em memoria

O bridge REST e parte do relay mantem **correlacao e filas em memoria** por
processo. Varias replicas sem afinidade de sessao ou store partilhado podem
perder pedidos pendentes ou duplicar comportamento estranho. Num **unico**
processo, afina primeiro throughput com os presets em `docs/performance_hub_agent.md`
antes de investir em store partilhado.

Estado explicitamente **por processo** hoje:

- `conversationRegistry` (conversas relay e idle timeout)
- pending requests REST/legacy socket
- rooms Socket.IO (`client:<id>`, `consumer:principal:*`, `client:custom.*`) quando
  `SOCKET_IO_REDIS_ADAPTER_URL` esta vazio; com adapter Redis,
  broadcast/`fetchSockets()` passam a atravessar replicas, mas varios handlers de
  negocio ainda dependem de estado local
- fila in-process de serializacao de publicacoes com `idempotencyKey` /
  `Idempotency-Key` (`client_socket_event_publish_idempotency_serialization`);
  replay/conflito pode ser partilhado por Redis com
  `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL`, mas a fila local continua protegendo
  o caminho dentro de cada processo
- joins em tempo real a `consumer:client-agent:{clientId}:{agentId}` quando um
  pedido de acesso e aprovado (`grantClientAccess`); com Redis adapter o
  `fetchSockets()` encontra sockets remotos, sem adapter fica limitado ao processo
  que trata a aprovacao
- estado em memoria do limitador `socket:event.publish`
  (`client_socket_event_publish_socket_rate_limiter`; Redis opcional com scope
  `client_socket_event_publish`, chave de identidade `client:<JWT sub do Client>`)
- `agentRegistry` e readiness/circuit local (dispatch local; presenca Redis +
  forward cobrem `POST /agents/commands` entre replicas quando configurado)
- mapa de idempotencia relay
- filas outbound hub -> consumer e buffers de stream
- fila relay por agente (`SOCKET_RELAY_AGENT_*`)

Consequencia pratica: em producao, `/consumers` e `/agents` ainda precisam de
**sticky sessions** (ou topologia equivalente que garanta afinidade) para que o
mesmo cliente/agent voltem ao processo que detem esse estado.

### Rate limits HTTP (`express-rate-limit`)

Todos os limitadores HTTP (`globalRateLimit`, `credentialAuthRateLimit`,
`agentsCommandsUserRateLimit`, `agentsCommandsIpRateLimit`, `adminUserStatusRateLimit`,
`clientMeAgentsPostRateLimit`, `clientSocketEventPublishRateLimit`,
`clientThumbnailRateLimit`, `clientPasswordRecoveryRequestRateLimit`,
`agentsSelfProfileRateLimit`) usam o **store default em memoria** do
`express-rate-limit` quando `REST_RATE_LIMIT_REDIS_URL` esta vazio. Em
multi-replica sem Redis:

- cada pod tem o seu balde, logo o **limite efetivo** se multiplica pelo numero de replicas;
- nao ha coordenacao para detetar abuso distribuido por tras de balanceador;
- recoveries / restarts zeram a janela para todas as IPs.

**Mitigacoes ja em producao:**

- `HTTP_TRUST_PROXY=true` faz `req.ip` refletir o cliente real atras de Nginx;
- `REST_RATE_LIMIT_REDIS_URL` opcional: quando definido, os limitadores HTTP
  `express-rate-limit` usam Redis (`rate-limit-redis`) para estado partilhado
  entre replicas, com prefixo isolado por limitador; vazio mantem store em
  memoria por processo. Falha na ligacao: log `rest_rate_limit_redis_fallback_memory`,
  metrica Prometheus `plug_rest_http_rate_limit_redis_fallback_events_total`,
  store em memoria. Falha runtime do store Redis: `passOnStoreError=true`, log
  `rest_rate_limit_redis_command_error`, request permitido sem rate-limit
  distribuido, metricas `plug_rest_http_rate_limit_redis_runtime_command_errors_total`
  / `plug_rest_http_rate_limit_redis_fallback_events_total` incrementadas. Apos
  erros consecutivos, o circuito Redis abre temporariamente
  (`plug_rest_http_rate_limit_redis_circuit_open=1`) para reduzir latencia em cascata;
- exemplo de chave Redis para `clientSocketEventPublishRateLimit`:
  `plug_rl:client_socket_event_publish:client:<JWT sub>` (o sufixo e o valor
  devolvido por `clientSocketEventPublishRateLimitKey` em `rate_limit.middleware.ts`);
- chaves dos limitadores autenticados usam `JWT sub`, nao IP; com Redis, o teto
  e partilhado entre replicas, e sem Redis o teto se multiplica pelo numero de
  pods que o usuario alcanca;
- `Retry-After` e `RateLimit-*` headers continuam corretos para o store efetivamente usado.

### Rate limits Socket

`SOCKET_RATE_LIMIT_REDIS_URL` distribui os limitadores de `agents:command`,
`agents:stream_pull`, `relay:conversation.start`, `relay:rpc.request`, creditos
de `relay:rpc.stream.pull`, `agent:register` e `socket:event.publish`
(`client_socket_event_publish`; chave Redis por cliente `client:<JWT sub>` dentro
desse scope). O comportamento e fail-open: queda/conexao instavel no Redis
registra `plug_socket_rate_limit_redis_*` e o hub volta ao limiter local em memoria.

Isso **nao** torna o Socket stateless. Conversas, pending requests, streams,
idempotencia relay, registry do agente e filas por agente continuam por processo.
Portanto sticky sessions seguem recomendadas/necessarias para `/consumers` e
`/agents` enquanto esses estados nao forem externalizados.

O pub/sub customizado (`POST /api/v1/client/me/socket-events` ou
`socket:event.publish` para `client:custom.*`) e local ao processo quando nao ha
adapter distribuido do Socket.IO. Com `SOCKET_IO_REDIS_ADAPTER_URL`, broadcast e
contagem de recipients via `fetchSockets()` cobrem replicas remotas. A idempotencia
via `Idempotency-Key` (REST) ou `idempotencyKey` (Socket) usa cache em memoria por
processo por defeito; com `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL`,
replay/conflito e o lock da primeira emissao passam a ser coordenados em Redis. A
**fila de serializacao** local continua existindo para reduzir dupla emissao dentro
do processo e para controlar `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS`.
Use `REST_SOCKET_EVENT_MAX_RECIPIENTS` para proteger fan-out em picos; sem Redis
adapter o teto observa apenas a replica local, com Redis adapter observa o total
via `fetchSockets()`.

**Salas `consumer:client-agent:*` apos aprovacao de acesso:** o handler
`grantClientAccess` corre no processo que executa `approveByToken` / `approveByOwner`.
Com `SOCKET_IO_REDIS_ADAPTER_URL`, o `fetchSockets` na room `client:{clientId}`
tambem encontra sockets remotos e tenta o `join` distribuido. Alem disso, cada
replica pode reconciliar periodicamente as rooms dos clients ligados com
`SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS` (defeito `30000`):
o sweep consulta acessos aprovados no backend e corrige joins/leaves perdidos.
Sem adapter Redis, a reconciliacao continua util para drift local, mas nao
enxerga sockets noutra replica; nessa topologia, clients noutra replica seguem
dependendo de **reconnect** ou sticky sessions.

**Proximos passos:** manter fail-open quando o Redis cair (politica conservadora:
se store indisponivel, deixar passar e logar) para evitar transformar uma falha de
cache num corte total de API. Para estado do bridge/relay Socket, o desenho ainda
assume **sticky sessions** ou um numero de replicas baixo o suficiente para que o
estado em memoria continue aceitavel.

Importante: jobs de manutencao **ja** estao coordenados por advisory lock (prune
de `audit_events`, prune de `bridge_latency_traces`, manutencao de perfil de
agente, sweep de expiracao `client_agent_access` e prune de dead letters do
outbox). Ou seja: multi-instancia continua delicado para estado em memoria do
bridge/relay, mas **nao** duplica mais o trabalho dos schedulers de retencao/prune.

**Caminhos possiveis:**

1. **Uma instancia** ou **sticky sessions** ao mesmo processo que trata o Socket do agente.
2. **Redis** (ou similar) para pending requests e conversas relay. Pub/sub
   `client:custom.*` e idempotencia dessa publicacao ja tem caminho Redis opcional;
   o restante do bridge ainda requer desenho cuidadoso de chaves e TTL.

Ver tambem a checklist em `docs/api_rest_bridge.md` (gaps / replicas).

## Streaming progressivo no REST (SSE ou chunked)

Hoje o `POST /api/v1/agents/commands` **materializa** resultados com `stream_id`
num unico JSON. **Server-Sent Events** ou resposta HTTP chunked com JSON por linha
seria um **novo contrato** publico (documentacao, clientes, testes, possivel
negociacao por header `Accept`).

Recomendacao: manter Socket para baixa latencia por chunk ate haver requisito firme
de cliente apenas HTTP.

## OpenTelemetry

O servico nao inclui SDK OTel por defeito. Integracao tipica:

- `instrumentation-http` + `instrumentation-express` para spans HTTP.
- Propagacao `traceparent` ja suportada no payload JSON-RPC; alinhar com o
  propagator W3C no middleware.

## Cliente / SDK

Um pacote npm partilhado (encode `PayloadFrame`, politica gzip **auto**) reduz
copia de codigo entre apps. Referencia minima em
[`docs/snippets/payload_frame_client_encode.ts`](snippets/payload_frame_client_encode.ts)
e em `docs/socket_client_sdk.md`.
