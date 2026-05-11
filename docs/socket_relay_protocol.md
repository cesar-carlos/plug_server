# Socket Relay Protocol (N:1)

Data: 2026-05-11

## Objetivo

Canal Socket em modo relay/chat-like para permitir varias conversas simultaneas
entre consumers e o mesmo agente, sem alterar o canal REST.

Este documento cobre o contrato relay `relay:*` no namespace `/consumers`.
Regras de negocio de ownership, aprovacao de `Client`, revogacao, conta ativa
e autorizacao por principal vivem em `docs/client_agent_business_rules.md`.
Para o mapa geral da documentacao, ver `docs/README.md`.
Para um guia de implementacao lado cliente, ver `docs/socket_client_sdk.md`.

Fluxo:

`consumer -> plug_server -> agente`

## Namespaces

- `/consumers`: controle de conversa e envio de frames relay
- `/agents`: protocolo padrao do agente (`rpc:*` em `PayloadFrame`)

Autorizacao resumida do relay:

- o handshake autentica o principal no namespace `/consumers`
- o namespace `/consumers` e **fail-closed**: conexoes sem JWT valido sao rejeitadas mesmo que outros namespaces usem fallback mais permissivo em ambiente de teste
- nas operacoes sensiveis, o servidor revalida conta ativa e acesso ao agente por evento
- `user` autoriza por `AgentIdentity`
- `client` autoriza por `ClientAgentAccess`
- `admin` pode operar qualquer agente ativo

## Handshake: `connection:ready`

Emitido imediatamente após autenticacao bem-sucedida. **Desde versao mais recente, enviado como `PayloadFrame`** para consistencia com outros eventos RPC.
No caso de principals `client`, o hub entra primeiro na room `client:<clientId>` e
so depois emite `connection:ready`; ao receber esse evento, o cliente ja esta apto
para receber `client:agent.profile.updated` sem race de room join.
Para cada par `(clientId, agentId)` com acesso aprovado, o hub entra tambem na room `consumer:client-agent:{clientId}:{agentId}` no connect. Quando o acesso e **concedido** (aprovacao por token ou pelo dono) enquanto o cliente ja tem sessao `/consumers` aberta, o servidor repete esse `join` **sem exigir reconnect**.

**Payload lógico após decode**:

```json
{
  "id": "<socket.id>",
  "message": "Consumer socket connected successfully",
  "user": { "sub": "...", "role": "...", "iat": ..., "exp": ... }
}
```

**Cliente deve decodificar**:

```typescript
socket.on("connection:ready", (rawPayload: unknown) => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    throw new Error(`Handshake failed: ${decoded.error.message}`);
  }
  // Pronto para emitir relay:conversation.start
});
```

**Compatibilidade**: existe um shim transitório controlado por `SOCKET_CONNECTION_READY_COMPAT_MODE`, mas o contrato padrão e suportado é `PayloadFrame`. O modo legado `raw_json` tem remoção planejada após `2026-09-30`.

## Eventos relay no /consumers

Controle:

- `relay:conversation.start`
- `relay:conversation.started`
- `relay:conversation.end`
- `relay:conversation.ended`

Dados:

- `relay:rpc.request`
- `relay:rpc.accepted`
- `relay:rpc.response`
- `relay:rpc.chunk`
- `relay:rpc.complete`
- `relay:rpc.request_ack`
- `relay:rpc.batch_ack`
- `relay:rpc.stream.pull`
- `relay:rpc.stream.pull_response`

Pub/sub customizado:

- `socket:event.subscribe`
- `socket:event.subscribed`
- `socket:event.unsubscribe`
- `socket:event.unsubscribed`
- `socket:event.publish`
- `socket:event.published`
- `client:custom.*` (evento dinamico publicado pelo hub apos REST ou `socket:event.publish`)

## Eventos de controle (JSON)

Eventos abaixo usam payload JSON logico (nao `PayloadFrame`):

- `relay:conversation.start` -> `{ agentId }`
- `relay:conversation.started` -> `{ success, conversationId, agentId, createdAt }` ou erro
- `relay:conversation.end` -> `{ conversationId }`
- `relay:conversation.ended` -> `{ success, conversationId, reason }` ou erro
- `relay:rpc.accepted` -> status de aceite/dedupe (`requestId`, `clientRequestId`, `deduplicated`, `replayed`, `inFlight`)
- `relay:rpc.stream.pull_response` -> status do pull (`requestId`, `streamId`, `windowSize`, `rateLimit`) ou erro
- `socket:event.subscribe` -> `{ requestId, eventName }`
- `socket:event.subscribed` -> `{ success, requestId, data: { eventName, subscribed, alreadySubscribed? }, error? }` — `alreadySubscribed: true` quando o socket ja estava inscrito nesse `eventName` (re-subscribe idempotente; a metrica `plug_socket_custom_event_subscribed_total` nao incrementa de novo)
- `socket:event.unsubscribe` -> `{ requestId, eventName }`
- `socket:event.unsubscribed` -> `{ success, requestId, data: { eventName, subscribed: false, wasSubscribed }, error? }` — `wasSubscribed` indica se havia entrada local no registo antes do `leave` (falso = unsubscribe idempotente sem subscricao previa)
- `socket:event.publish` -> `{ requestId, eventName, payload, idempotencyKey?, payloadFrameCompression?, attachments? }` (JSON; apenas principal `client`)
- `socket:event.published` -> `{ success, requestId, data?: { eventId, eventName, recipients, idempotencyKey?, idempotentReplay }, error? }` (ack; nao `PayloadFrame`)

## Pub/sub customizado REST ou Socket

O namespace `/consumers` tambem oferece um pub/sub simples para eventos de
aplicacao. Sockets autenticados como **Client** (`principal_type: client`) assinam eventos `client:custom.*`; um `Client`
publica via **`POST /api/v1/client/me/socket-events`** (REST) **ou**
**`socket:event.publish`** no `/consumers` com o mesmo JWT; o hub emite o
evento dinamico para todos os sockets locais inscritos.

Regras:

- apenas prefixo `client:custom.` e permitido;
- eventos internos (`agent:*`, `agents:*`, `relay:*`, `rpc:*`, `hub:*`,
  `connection:*`, `app:*`, `client:agent.*`, `socket:event.*`) ficam fora do
  prefixo aceito e nao podem ser publicados;
- subscribe/unsubscribe/publish usam JSON puro com envelope de ack no subscribe/unsubscribe e em `socket:event.published` para publish;
- `socket:event.subscribe` / `socket:event.unsubscribe` aceitam apenas principal **Client** (JWT com `principal_type: client` e `sub`); `user`/`admin` recebem `403` / `FORBIDDEN` sem consumir o rate limit de subscribe;
- `socket:event.publish` aplica o limite de inflight partilhado (`SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`) **ou**, quando `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` > 0, um contador **dedicado** so para publicacoes custom (relay/comandos nao consomem esse teto; com **ambos** > 0 os contadores somam no maximo em voo); e um rate limit **separado** do Express; por defeito usam-se as mesmas env numericas que `POST /client/me/socket-events` (`REST_SOCKET_EVENT_RATE_LIMIT_*`), com overrides opcionais **só Socket** `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_*` (ver `docs/configuration.md`); com `SOCKET_RATE_LIMIT_REDIS_URL`, o scope Redis e `client_socket_event_publish` e a chave de identidade e `client:<JWT sub do Client>`; apos consumir quota, falhas **transientes** do publish (ex.: `503` fan-out local) **devolvem** a contagem na janela; conflitos de idempotencia (`409` / `IDEMPOTENCY_KEY_CONFLICT`) **nao** devolvem quota (erro de cliente);
- antes do parse Zod, o hub rejeita envelopes JSON brutos acima de um teto derivado dos limites REST (`PAYLOAD_TOO_LARGE` / `413` no ack) para cortar cargas maliciosas cedo;
- cada socket tem limite configuravel de inscricoes simultaneas
  (`SOCKET_CUSTOM_EVENT_MAX_SUBSCRIPTIONS_PER_SOCKET`) e rate limit local para
  controles `socket:event.*`;
- o evento dinamico `client:custom.*` usa `PayloadFrame`;
- payload logico do frame: `{ eventId, eventName, emittedAt, publisher, payload, attachments }`;
- `publisher` e derivado do JWT do `Client`, nunca do corpo da publicacao;
- `attachments` sao inline e pequenos (`base64`); no REST vêm de multipart; no Socket podem ir no array `attachments` com o mesmo shape logico;
- a resposta REST ou o ack `socket:event.published` confirmam emissao local no hub, nao processamento por listeners; se o socket fechar antes do hub emitir o ack, o cliente pode nao receber `socket:event.published` (o hub evita escrever num socket ja desligado);
- **Idempotencia unificada (REST e Socket):** o cache em memoria e partilhado por `clientId` (JWT `sub` do `Client`) e pela mesma chave logica: cabecalho HTTP `Idempotency-Key` e campo `idempotencyKey` no `socket:event.publish` escrevem na **mesma** entrada (`client_socket_event_idempotency_store`). O corpo e resumido por fingerprint (SHA-256 canónico); repetir a chave noutro canal com o mesmo corpo devolve replay sem nova emissao; corpo divergente devolve `409` / `IDEMPOTENCY_KEY_CONFLICT` em qualquer canal. Com `REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS` > 0, publicacoes **concorrentes** no mesmo processo com a mesma chave passam por **fila por chave** (`client_socket_event_publish_idempotency_serialization`) para nao emitir duas vezes antes da escrita no cache; quando a cadeia termina, a entrada do mapa e removida (chaves unicas nao acumulam para sempre). Com TTL **`0`**, nao ha replay guardado: pedidos **sequenciais** com a mesma chave podem **emitir de novo** (a fila so protege concorrencia). Opcional: `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` > 0 limita quantas chaves **distintas** podem estar em serializacao em simultaneo neste processo; em excesso, novas chaves recebem `503` / `SERVICE_UNAVAILABLE` com `error.details.retry_after_ms` = `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (como no `503` de fan-out). Quando `REST_SOCKET_EVENT_IDEMPOTENCY_MAX_ENTRIES` enche, o hub remove entradas pela **ordem de insercao** do mapa (nao por expiracao mais antiga). **Nao** substitui coordenacao entre replicas (ver escala). Cuidado em migracoes e testes para nao reutilizar chaves globais entre canais sem querer.
- `Idempotency-Key` no REST **ou** campo `idempotencyKey` no `socket:event.publish` evita emissao duplicada em retry; replay retorna
  `idempotentReplay: true`, e reuso da chave com outro corpo retorna `409` (REST) ou `success: false` com `IDEMPOTENCY_KEY_CONFLICT` (Socket);
- `REST_SOCKET_EVENT_MAX_RECIPIENTS` pode limitar fan-out local e rejeitar com
  `503` quando houver inscritos demais; `error.details.retry_after_ms` usa `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (por defeito `2000`), independentemente da janela `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`;
- convencao de produto: nomes `client:custom.*` sao **globais** por hub para quem subscreve o mesmo `eventName`; prefira prefixar por tenant ou cliente (ex.: `client:custom.acme-tenant.notifications`) para evitar colisao entre tenants.

Sem adapter distribuido do Socket.IO, o pub/sub e por processo: uma publicacao
REST ou `socket:event.publish` chega aos sockets inscritos na mesma replica. Em producao multi-replica,
use sticky sessions/topologia equivalente ou trate adapter/pub-sub distribuido
como evolucao de arquitetura.

### `relay:conversation.ended.reason`

Valores publicos documentados:

- `consumer_ended`: o proprio consumer encerrou a conversa com `relay:conversation.end`
- `agent_disconnected`: o socket do agente caiu enquanto a conversa ainda existia
- `expired`: a conversa foi removida pelo idle timeout

`consumer_disconnected` pode existir como razao **interna** de cleanup do hub, mas
nao deve ser tratado como contrato publico para SDKs.

## Contrato RPC e metodos suportados

O consumer deve enviar payloads que sigam o contrato do plug_agente. Referencia:
`plug_agente/docs/communication/socket_communication_standard.md`.

**Metodos suportados:** `sql.execute`, `sql.executeBatch`, `sql.cancel`, `rpc.discover`, `agent.getHealth`, `agent.getProfile`, `client_token.getPolicy`, `observer.register`, `observer.unregister`, `observer.list`.

**Opcoes relevantes em `sql.execute`:** `execution_mode` (`managed` | `preserve`),
`preserve_sql` (alias legado), `page`, `page_size`, `cursor`, `multi_result`, etc.

O servidor valida o payload com o schema do bridge (mesmas regras por comando do REST; no relay apenas comando unico) antes de encaminhar, incluindo **tetos UTF-8** do JSON logico (`sql` ate 1 MiB em `sql.execute` e `observer.register`, `params` nomeado serializado ate 2 MiB, `agent.getHealth` / `agent.getProfile` / `client_token.getPolicy` / `rpc.discover` `params` ate 64 KiB — ver `docs/api_rest_bridge.md`). A ordem pratica no `/consumers` ficou assim:

- validacao barata de envelope JSON acontece antes do rate limit fixo
- validacao profunda do `PayloadFrame` / JSON-RPC pode ocorrer depois do `allowRelayRpcRequest`
- se essa validacao profunda falhar com erro `400`, ou se o pedido cair em dedupe (`deduplicated: true`), o hub **devolve a quota consumida** na janela do consumer

Payloads invalidos retornam erro `VALIDATION_ERROR` em `relay:rpc.accepted`. O relay **nao**
suporta batch JSON-RPC (array); envie um unico request por `relay:rpc.request`.

Ao reenviar o comando para o agente, o hub encaminha apenas os campos `meta`
publicados pelo schema do `plug_agente` e reescreve `request_id`, `agent_id`,
`timestamp` e `trace_id`. Campos extras aceitos na entrada por compatibilidade
nao seguem no `rpc:request` agent-side.

**Notifications no relay:** `id: null` nao e aceito em `relay:rpc.request`. O relay exige request correlacionavel para timeout, idempotencia e roteamento de resposta/chunks.

O servidor normaliza `preserve_sql: true` para `execution_mode: "preserve"` antes
de enviar ao agente.

## Payload

No relay, o consumer envia `PayloadFrame` em:

- `relay:rpc.request` (campo `frame`)
- `relay:rpc.stream.pull` (campo `frame`)

Envelope JSON de `relay:rpc.request`: `conversationId`, `frame` (PayloadFrame) e, opcional, `payloadFrameCompression`: `default` \| `none` \| `always` — define gzip do frame que o hub **re-encoda** ao emitir `rpc:request` para o agente (o consumer frame e sempre descodificado antes).

O servidor encaminha para o agente como `rpc:*` e reenvelopa respostas/chunks em
`PayloadFrame` para o consumer.

### PayloadFrame (binario/compressao/assinatura)

Campos relevantes do frame:

- `schemaVersion` (`1.0`)
- `enc` (`json`)
- `cmp` (`none` ou `gzip`)
- `contentType` (`application/json`)
- `originalSize` / `compressedSize`
- `payload` (binario: `Buffer`, `Uint8Array`, array de bytes, ou string base64 na serializacao JSON)
- `requestId` no envelope (quando aplicavel); `traceId` opcional — em mensagens de stream relay de alto debito (`relay:rpc.chunk`, `relay:rpc.complete`, acks relay) o hub pode omitir `traceId` e correlacionar apenas por `requestId`
- `signature` opcional (`hmac-sha256`)

Regras atuais no servidor:

- validacao estrutural do envelope recebido (agente/consumer → hub) alinhada ao schema `payload-frame.schema.json` do plug_agente: `schemaVersion` **1.0**, `contentType` **application/json**, inteiros nao negativos, sem chaves desconhecidas no raiz; bloco `signature` sem propriedades extra (`isPayloadFrameEnvelope` em `payload_frame.ts`)
- compressao de saida: acima do limiar, modo **automatico** (gzip so quando a economia supera `PAYLOAD_FRAME_AUTO_GZIP_MIN_SAVINGS_BYTES`) no hub por defeito; `payloadFrameCompression: always` forca gzip como no agente “sempre GZIP”
- para JSON UTF-8 **acima do teto configuravel** (`PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES`, defeito **512 KiB**), o hub **nao tenta** gzip na codificacao interna (`preencodePayloadFrameJson` em `payload_frame.ts`); o frame segue com `cmp: none` ate ao limite de `10 MB` no fio
- limites de despacho (`max_rows`, `max_batch_size`) seguem politica efetiva por agente: o hub aplica o minimo entre o contrato anunciado e limites declarados pelo agente nas capabilities, quando presentes. `max_concurrent_streams` permanece informativo no handshake nesta fase.
- limite de payload comprimido: `10 MB`
- limite de payload decodificado: `10 MB`
- limite de inflacao gzip: `20x`
- frames inbound **sem** `signature` continuam aceitos por defeito; a verificacao e
  aplicada apenas quando a assinatura vem presente no envelope
- se `signature` vier no frame, o servidor valida com `PAYLOAD_SIGNING_KEY`
  (quando nao configurada e houver assinatura, a validacao falha). Quando
  `PAYLOAD_SIGNING_KEY_ID` esta configurado, `signature.key_id` passa a ser
  **obrigatorio** e validado: ausente ou divergente -> falha com `-32001`
  (`invalid_signature`). Sem `PAYLOAD_SIGNING_KEY_ID`, deployments single-key
  continuam aceitando assinaturas sem `key_id`. Ver
  `payload-frame.schema.json` no `plug_agente`.
- se `rpc:response` chegar com frame invalido mas com `requestId` identificavel no
  envelope, o hub encerra a request relay correlacionada com erro JSON-RPC framed
  em vez de esperar apenas por timeout
- se `rpc:chunk` ou `rpc:complete` chegarem com frame invalido mas com `requestId`
  identificavel no envelope, o hub encerra o stream relay com `relay:rpc.complete`
  terminal (`terminal_status: "error"`) em vez de deixar o consumer pendurado

## Correlacao de IDs no relay

- O `id` JSON-RPC enviado pelo consumer e tratado como `client_request_id`
  para idempotencia por conversa.
- O servidor gera/normaliza um `requestId` interno e repassa esse valor como
  `id` no payload enviado ao agente.
- Respostas `relay:rpc.response/chunk/complete` correlacionam pelo `requestId`
  interno da conversa.

### Semantica de idempotencia (`relay:rpc.accepted`)

Quando um `client_request_id` chega repetido **na mesma conversa** dentro do TTL:

- se a resposta original ja foi persistida no mapa de idempotencia, o hub devolve
  `deduplicated: true, replayed: true` e reenvia imediatamente o mesmo
  `relay:rpc.response`;
- se a request original **ainda esta em voo**, o hub devolve
  `deduplicated: true, inFlight: true` (sem `replayed`) e **regista o socket
  duplicado como waiter**; quando a resposta real chegar, o hub reenviara o
  mesmo `relay:rpc.response` para todos os waiters dessa conversa.

Em outras palavras: quando `inFlight: true`, o cliente **nao** deve repetir a
request nem abrir nova conversa; deve apenas esperar o `relay:rpc.response`
correspondente ao `requestId` original.

Capacidade operacional:

- `SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION` e `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES` continuam a tentar eviccao FIFO de entradas **completadas**
- entradas **in-flight** nao sao removidas so para abrir espaco
- se o cap estiver cheio e so existirem entradas in-flight nao-evictables, o hub
  rejeita a nova request com erro de capacidade (`503`) em vez de crescer sem limite

## Isolamento por conversa

- Cada conversa possui `conversationId`.
- O servidor valida ownership (`conversationId` pertence ao `consumerSocketId`).
- O mesmo agente pode atender varias conversas simultaneas de consumidores diferentes.
- `stream.pull` so atua em stream da propria conversa.
- O hub pode abrir a conversa antes, mas so faz **dispatch RPC** para agentes que
  ja passaram pela curta janela de estabilizacao apos `agent:register`
  (`SOCKET_AGENT_PROTOCOL_READY_GRACE_MS`) ou que ja emitiram `agent:heartbeat`;
  agentes mais novos podem anunciar `extensions.protocolReadyAck` e liberar o
  dispatch explicitamente com `agent:ready`, reduzindo corrida com
  `protocol_not_ready`.

## Confiabilidade e desempenho aplicados

- Idempotencia por conversa: requests com mesmo `client_request_id` na mesma
  conversa sao deduplicadas por TTL. Duplicatas em voo recebem
  `relay:rpc.accepted` com `inFlight: true` e sao replayadas quando a resposta
  original chega.
- Acks do agente (`rpc:request_ack` / `rpc:batch_ack`) sao observados e
  reenviados ao consumer quando aplicavel, mas o hub ainda nao faz resend
  automatico de `rpc:request` se esses acks faltarem.
- Timeout de relay request: quando o agente nao responde no prazo, o servidor
  devolve erro JSON-RPC no `relay:rpc.response`.
- Circuit breaker por agente: falhas consecutivas abrem circuito por janela
  curta, bloqueando novas requests temporariamente.
- Fila por agente no relay: `relay:rpc.request` passa por um gate FIFO por
  `agentId` antes do dispatch ao socket do agente. Isso evita que muitos
  consumers sobrecarreguem o mesmo agente. Overload retorna erro
  `SERVICE_UNAVAILABLE` com `retryAfterMs`.
- Backpressure reforcado: chunks no relay respeitam creditos de
  `relay:rpc.stream.pull`, e o orçamento de creditos do consumer e validado
  **antes** de o hub conceder novos credits/pulls ao agente. Se o pull for aceite
  mas a execucao falhar antes de concluir, os creditos concedidos nessa tentativa
  sao devolvidos para a janela do consumer.
- Buffer com limites: chunks sao bufferizados por request e globalmente com cap
  de memoria para evitar explosao de uso; se o agente exceder esse buffer, o hub
  fecha o stream com `relay:rpc.complete` terminal (`terminal_status: "aborted"`)
  em vez de descartar chunks silenciosamente.
- Pull capability-aware: o hub **publica** os hints
  `recommendedStreamPullWindowSize` e `maxStreamPullWindowSize` (derivados de
  `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`) e limite maximo
  (`SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE`) em `agent:capabilities.extensions`
  para o agente calibrar `rpc:stream.pull` sem heuristica propria; o hub garante
  `recommendedStreamPullWindowSize <= maxStreamPullWindowSize`; quando o
  agente anuncia esses mesmos campos em `extensions` ou `limits`, o hub aplica
  o clamp tanto no pull interno quanto nas requests do consumer
  (`agent_registry.resolveStreamPullWindow`).
- Quotas de protecao: limites para conversas, pending requests por conversa e
  por consumer.
- Limpeza por inatividade: conversas inativas expiram automaticamente por TTL.
- Metricas em memoria: o servidor registra contadores de throughput, timeout,
  dedupe, perdas por backpressure e terminais explicitos de stream.

Configuracao via variaveis de ambiente em `.env.example`.

Variaveis principais do relay:

- `SOCKET_RELAY_REQUEST_TIMEOUT_MS`
- `SOCKET_RELAY_CONVERSATION_IDLE_TIMEOUT_MS`
- `SOCKET_RELAY_CONVERSATION_SWEEP_INTERVAL_MS`
- `SOCKET_RELAY_MAX_CONVERSATIONS`
- `SOCKET_RELAY_MAX_CONVERSATIONS_PER_CONSUMER`
- `SOCKET_RELAY_MAX_PENDING_REQUESTS`
- `SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONVERSATION`
- `SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONSUMER`
- `SOCKET_RELAY_MAX_ACTIVE_STREAMS`
- `SOCKET_RELAY_MAX_BUFFERED_CHUNKS_PER_REQUEST`
- `SOCKET_RELAY_MAX_TOTAL_BUFFERED_CHUNKS`
- `SOCKET_RELAY_IDEMPOTENCY_TTL_MS`
- `SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION`
- `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES`
- `SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD`
- `SOCKET_RELAY_CIRCUIT_OPEN_MS`
- `SOCKET_RELAY_METRICS_LOG_INTERVAL_MS`
- `SOCKET_RELAY_RATE_LIMIT_WINDOW_MS`
- `SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS`
- `SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS`
- `SOCKET_RELAY_AGENT_MAX_INFLIGHT`
- `SOCKET_RELAY_AGENT_MAX_QUEUE`
- `SOCKET_RELAY_AGENT_QUEUE_WAIT_MS`
- `SOCKET_RATE_LIMIT_REDIS_URL`

### Rate limit por consumer (janela fixa)

Os limites `SOCKET_RELAY_RATE_LIMIT_*` aplicam-se por identidade lógica (`relay:user:<sub>` quando autenticado; `relay:anon:<socketId>` como fallback) e usam **janela fixa**: quando decorre `SOCKET_RELAY_RATE_LIMIT_WINDOW_MS` desde o inicio da janela, os contadores de `relay:conversation.start`, `relay:rpc.request` e do orçamento de créditos de `relay:rpc.stream.pull` **zeram** de uma vez. Nao e _sliding window_; o trafego pode concentrar-se nos limites de cada janela. Estados inativos sao removidos pelo sweep periodico (`SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER` x duracao da janela) e ao disconnect apenas para chaves anónimas.

Métricas Prometheus em `GET /metrics`: `plug_socket_relay_rate_limit_conversation_start_allowed_total`, `..._rejected_total`, `plug_socket_relay_rate_limit_request_allowed_total`, `..._rejected_total`, etc.

Quando `SOCKET_RATE_LIMIT_REDIS_URL` esta vazio, os contadores ficam em memoria
por processo. Quando configurado, os limitadores Socket usam Redis com fallback
fail-open/circuit breaker: em falha de conexao/comando, o hub registra metricas
e volta ao limiter local para nao transformar cache indisponivel em queda total
do Socket. Isso distribui apenas rate limit; registries, conversas, pending
requests e idempotencia relay continuam por processo, portanto sticky sessions
seguem obrigatorias em multi-replica.

Metricas adicionais: `plug_socket_rate_limit_redis_*` para Redis/fallback,
`plug_socket_relay_dispatch_*` para a fila por agente e
`plug_socket_consumers_retry_after_ms_propagated_total` para propagacao de
`retryAfterMs`.

### Fila por agente no relay

`SOCKET_RELAY_AGENT_MAX_INFLIGHT` limita requests relay simultaneas por agente.
Quando o limite e atingido, novas requests entram em fila FIFO ate
`SOCKET_RELAY_AGENT_MAX_QUEUE`. Se a fila estiver cheia ou o tempo de espera
passar de `SOCKET_RELAY_AGENT_QUEUE_WAIT_MS`, o hub rejeita com
`SERVICE_UNAVAILABLE` e `retryAfterMs`.

O slot e liberado no termino real da request: `relay:rpc.response`,
`relay:rpc.complete`, timeout, abort ou disconnect do consumer/agente. Isso
preserva backpressure entre varias conversas apontando para o mesmo agente.

`relay:rpc.stream.pull_response` inclui:

```json
{
  "success": true,
  "requestId": "req-1",
  "streamId": "stream-1",
  "windowSize": 32,
  "rateLimit": {
    "remainingCredits": 768,
    "limit": 1000,
    "scope": "user"
  }
}
```

Quando o orçamento estoura, o hub responde com `success: false`, `error.code = "RATE_LIMITED"` e preserva o bloco `rateLimit` com o saldo restante.

Separadamente do orçamento de relay, handlers consumer (`agents:command`,
`relay:rpc.request`, `agents:stream_pull`, `relay:rpc.stream.pull`) tambem
respeitam `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`. Acima desse teto o hub
responde `RATE_LIMITED` imediatamente, sem entrar na bridge.

### Shed load em `/consumers`

Se a fila outbound relay exceder backlog ou latência p95 configurados, o hub passa a rejeitar temporariamente novos eventos relay em `/consumers` com `SERVICE_UNAVAILABLE` e `retryAfterMs`. Variáveis principais:

- `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG`
- `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS`
- `SOCKET_RELAY_OUTBOUND_TAIL_STALE_MS`
- `SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS`

## Auditoria Socket e retencao

Foi adicionada auditoria de eventos Socket em `audit_events` com limpeza
automatica de registros antigos.

Politica default:

- retencao: 90 dias
- frequencia de limpeza: a cada 24h

Variaveis de ambiente:

- `SOCKET_AUDIT_RETENTION_DAYS` (default `90`)
- `SOCKET_AUDIT_RETENTION_INTERVAL_MINUTES` (default `1440`)
- `SOCKET_AUDIT_PRUNE_BATCH_SIZE` (default `5000`)

## Observabilidade

Endpoint de metricas:

- `GET /metrics` (Prometheus text)
- `GET /api/v1/metrics` (mesmo payload, sob prefixo da API)

Inclui:

- throughput relay, dedupe, timeout, drop de chunk
- gauges de pending requests, streams e circuit breaker
- latencia por agente (count/avg/max)
- rate-limit allow/reject no relay
- escrita e limpeza da auditoria

## Migracao de banco

Aplicar migration para criar `audit_events`:

```bash
npm run db:migrate:deploy
```

Arquivo da migration:

- `prisma/migrations/20260317184000_add_audit_events/migration.sql`

## Compatibilidade

Fluxo legado Socket (`agents:command` e `agents:stream_pull`) permanece ativo.
O mesmo contrato de comando ao agente existe em **paralelo** via
`POST /api/v1/agents/commands` (REST): o cliente pode usar **só REST**, **só Socket**
ou **combinar** (ex.: auth HTTP + comandos Socket). O REST **nao** expoe streaming
progressivo ao cliente (materializacao no hub); ver `docs/PROJECT_OVERVIEW.md`
(_Dois canais para comandos ao agente_).

## SDK cliente

Exemplo minimo de cliente relay:

- `docs/socket_client_sdk.md`
