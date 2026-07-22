# Socket Relay Protocol (N:1)

Data: 2026-05-11

## Objetivo

Canal Socket em modo relay/chat-like para permitir varias conversas simultaneas
entre consumers e o mesmo agente, sem alterar o canal REST.

Este documento cobre o contrato relay `relay:*` no namespace `/consumers`.
Regras de negocio de ownership, aprovacao de `Client`, revogacao, conta ativa
e autorizacao por principal vivem em `docs/api/client_agent_business_rules.md`.
Para o mapa geral da documentacao, ver `docs/README.md`.
Para um guia de implementacao lado cliente, ver `docs/socket/socket_client_sdk.md`.

Fluxo:

`consumer -> plug_server -> agente`

## Namespaces

- `/consumers`: controle de conversa e envio de frames relay
- `/agents`: protocolo padrao do agente (`rpc:*` em `PayloadFrame`)

Autorizacao resumida do relay:

- o handshake autentica o principal no namespace `/consumers`
- o namespace `/consumers` e **fail-closed**: conexoes sem JWT valido sao rejeitadas mesmo que outros namespaces usem fallback mais permissivo em ambiente de teste
- nas operacoes sensiveis, o servidor revalida conta ativa e acesso ao agente por evento
  (com defaults estritos: `SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS` e
  `SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS` em `0` = DB a cada evento; TTLs > 0
  podem atrasar a observacao de block/revoke ate ao fim da janela — ver
  `docs/configuration.md`)
- `user` autoriza por `AgentIdentity`
- `client` autoriza por `ClientAgentAccess`
- `admin` pode operar qualquer agente ativo

## Handshake: `connection:ready`

Emitido imediatamente após autenticacao bem-sucedida. **Desde versao mais recente, enviado como `PayloadFrame`** para consistencia com outros eventos RPC.
No caso de principals `client`, o hub entra primeiro na room `client:<clientId>` e
so depois emite `connection:ready`; ao receber esse evento, o cliente ja esta apto
para eventos enviados a essa room base.
As rooms derivadas por acesso aprovado (`consumer:client-agent:{clientId}:{agentId}`
e a room agregada de profile por agente) sao preenchidas de forma assincrona logo
apos o ready, com dedupe por `clientId` dentro da instancia do hub. Quando o
acesso e **concedido** (aprovacao por token ou pelo dono) enquanto o cliente ja
tem sessao `/consumers` aberta, o servidor faz o `join` no fast path **sem exigir
reconnect**. O reconcile periodico corrige drift; clientes devem usar os
endpoints REST de catalogo/acesso como fonte de verdade para estado completo.

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

- `relay:rpc.request` — envelope JSON: `{ conversationId, frame, payloadFrameCompression?, requestServerTimings?, fastPath? }`. Os dois ultimos sao opt-in documentados em "Relay unary fast-path" e "Server-side phase diagnostics" abaixo.
- `relay:rpc.request.batch` — batch variant. Envelope JSON: `{ conversationId, frame, payloadFrameCompression?, requestServerTimings?, fastPath? }` onde `frame.data` decodifica para um array de 1..32 JSON-RPC requests. Gated por `SOCKET_RELAY_BATCH_ENABLED` (default `false`). Ver "Relay JSON-RPC batch" abaixo.
- `relay:rpc.accepted`
- `relay:rpc.batch_accepted` — ack unico para o batch envelope acima, carrega per-item `clientRequestId → requestId` + dedup state.
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

- `relay:conversation.start` -> `{ requestId?, agentId }`
- `relay:conversation.started` -> `{ success, requestId?, conversationId, agentId, createdAt }` ou erro; quando `requestId` valido (`1..128` chars apos trim) for enviado no start, ele e ecoado tambem em erros de validacao, overload e rate limit
- `relay:conversation.end` -> `{ requestId?, conversationId }`
- `relay:conversation.ended` -> `{ success, requestId?, conversationId, reason }` ou erro; `requestId` so e ecoado quando valido (`1..128` chars apos trim)
- `relay:rpc.accepted` -> status de aceite/dedupe (`requestId`, `clientRequestId`, `deduplicated`, `replayed`, `inFlight`)
- `relay:rpc.stream.pull_response` -> status do pull (`requestId`, `streamId`, `windowSize`, `rateLimit`) ou erro
- `socket:event.subscribe` -> `{ requestId, eventName }`; em erro pre-handler, `requestId` so e ecoado quando for string valida (`1..128` chars apos trim)
- `socket:event.subscribed` -> `{ success, requestId, data: { eventName, subscribed, alreadySubscribed? }, error? }` — `alreadySubscribed: true` quando o socket ja estava inscrito nesse `eventName` (re-subscribe idempotente; a metrica `plug_socket_custom_event_subscribed_total` nao incrementa de novo)
- `socket:event.unsubscribe` -> `{ requestId, eventName }`
- `socket:event.unsubscribed` -> `{ success, requestId, data: { eventName, subscribed: false, wasSubscribed }, error? }` — `wasSubscribed` indica se havia entrada local no registo antes do `leave` (falso = unsubscribe idempotente sem subscricao previa)
- `socket:event.publish` -> `{ requestId, eventName, payload, idempotencyKey?, payloadFrameCompression?, attachments? }` (JSON; apenas principal `client`); em erro pre-handler, `requestId` so e ecoado quando for string valida (`1..128` chars apos trim)
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
- `socket:event.subscribe` / `socket:event.unsubscribe` aceitam apenas principal **Client** (JWT com `principal_type: client` e `sub`); `user`/`admin` recebem `403` / `FORBIDDEN` no ack **sem** disconnect (a sessao relay / `agents:*` permanece aberta) e sem consumir o rate limit de subscribe;
- `socket:event.publish` aplica o limite de inflight partilhado (`SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`) **ou**, quando `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` > 0, um contador **dedicado** so para publicacoes custom (relay/comandos nao consomem esse teto; com **ambos** > 0 os contadores somam no maximo em voo); e um rate limit **separado** do Express; por defeito usam-se as mesmas env numericas que `POST /client/me/socket-events` (`REST_SOCKET_EVENT_RATE_LIMIT_*`), com overrides opcionais **só Socket** `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_*` (ver `docs/configuration.md`); com `SOCKET_RATE_LIMIT_REDIS_URL`, o scope Redis e `client_socket_event_publish` e a chave de identidade e `client:<JWT sub do Client>`; apos consumir quota, falhas **transientes** do publish (ex.: `503` fan-out local) **devolvem** a contagem na janela (best-effort: se o refund falhar, `WARN` `client_socket_event_publish_rate_limit_refund_failed` e o ack mantem o erro original do publish); **4xx** do `execute` (validacao, `413`, etc.) e conflitos de idempotencia (`409` / `IDEMPOTENCY_KEY_CONFLICT`) **nao** devolvem quota; **429** por inflight cheio ou por `allow === false` **nao** consumiram essa quota de publish; **429** em `socket:event.subscribe` (ex. `SUBSCRIPTION_LIMIT_EXCEEDED`) vem de outro limitador e nao afecta esta quota;
- antes do parse Zod, o hub rejeita envelopes JSON brutos acima de um teto derivado dos limites REST e de `SOCKET_IO_MAX_HTTP_BUFFER_BYTES` (`PAYLOAD_TOO_LARGE` / `413` no ack; `error.details` inclui `maxRawEnvelopeUtf8Bytes` / `maxEngineIoBufferBytes` quando aplicavel) para cortar cargas maliciosas cedo;
- cada socket tem limite configuravel de inscricoes simultaneas
  (`SOCKET_CUSTOM_EVENT_MAX_SUBSCRIPTIONS_PER_SOCKET`) e rate limit local para
  controles `socket:event.*`;
- a quota de `socket:event.subscribe` / `socket:event.unsubscribe` e consumida
  **depois** de `join` / `leave` na room ter sucesso; se o rate limit estourar
  nessa fase, o hub faz rollback best-effort (`leave` apos subscribe falho,
  `join` apos unsubscribe falho) para nao deixar o socket num estado incoerente;
- o evento dinamico `client:custom.*` usa `PayloadFrame`;
- payload logico do frame: `{ eventId, eventName, emittedAt, publisher, payload, attachments }`;
- `publisher` e derivado do JWT do `Client`, nunca do corpo da publicacao;
- `attachments` sao inline e pequenos (`base64`); no REST vêm de multipart; no Socket podem ir no array `attachments` com o mesmo shape logico;
- a resposta REST ou o ack `socket:event.published` confirmam emissao local no hub, nao processamento por listeners; se o socket fechar antes do hub emitir o ack, o cliente pode nao receber `socket:event.published` (o hub evita escrever num socket ja desligado);
- **Idempotencia unificada (REST e Socket):** por defeito, o cache em memoria e partilhado por `clientId` (JWT `sub` do `Client`) e pela mesma chave logica: cabecalho HTTP `Idempotency-Key` e campo `idempotencyKey` no `socket:event.publish` escrevem na **mesma** entrada (`client_socket_event_idempotency_store`). O corpo e resumido por fingerprint (SHA-256 canonico); repetir a chave noutro canal com o mesmo corpo devolve replay sem nova emissao; corpo divergente devolve `409` / `IDEMPOTENCY_KEY_CONFLICT` em qualquer canal. Com `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL`, replay/conflito e lock da primeira emissao tambem sao coordenados entre replicas. Com `REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS` > 0, publicacoes **concorrentes** no mesmo processo com a mesma chave passam por **fila por chave** (`client_socket_event_publish_idempotency_serialization`) para nao emitir duas vezes antes da escrita no cache; quando a cadeia termina, a entrada do mapa e removida. Com TTL **`0`**, nao ha replay guardado: pedidos **sequenciais** com a mesma chave podem **emitir de novo**. Opcional: `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` > 0 limita quantas chaves **distintas** podem estar em serializacao em simultaneo neste processo; em excesso, novas chaves recebem `503` / `SERVICE_UNAVAILABLE` com `error.details.retry_after_ms` = `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS`. Quando `REST_SOCKET_EVENT_IDEMPOTENCY_MAX_ENTRIES` enche, o hub remove entradas pela **ordem de insercao** do mapa. Cuidado em migracoes e testes para nao reutilizar chaves globais entre canais sem querer.
- `Idempotency-Key` no REST **ou** campo `idempotencyKey` no `socket:event.publish` evita emissao duplicada em retry; replay retorna
  `idempotentReplay: true`, e reuso da chave com outro corpo retorna `409` (REST) ou `success: false` com `IDEMPOTENCY_KEY_CONFLICT` (Socket);
- `REST_SOCKET_EVENT_MAX_RECIPIENTS` pode limitar fan-out e rejeitar com
  `503` quando houver inscritos demais; sem Redis adapter a contagem usa o mapa local de rooms, com `SOCKET_IO_REDIS_ADAPTER_URL` usa `fetchSockets()` para cobrir replicas remotas. `error.details.retry_after_ms` usa `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (por defeito `2000`), independentemente da janela `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`;
- quando `fetchSockets()` falha com Redis adapter ativo, o hub so emite em modo
  degradado se a contagem local estiver abaixo de
  `REST_SOCKET_EVENT_BEST_EFFORT_LOCAL_MAX_RECIPIENTS`; apos falhas consecutivas
  o circuito abre e publicacoes novas retornam `503` retryable;
- convencao de produto: nomes `client:custom.*` sao **globais** por hub para quem subscreve o mesmo `eventName`; prefira prefixar por tenant ou cliente (ex.: `client:custom.acme-tenant.notifications`) para evitar colisao entre tenants.

Sem adapter distribuido do Socket.IO, o pub/sub e por processo: uma publicacao
REST ou `socket:event.publish` chega aos sockets inscritos na mesma replica. Em producao multi-replica,
configure `SOCKET_IO_REDIS_ADAPTER_URL` para broadcast entre replicas e
`REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL` para idempotencia distribuida de
publicacoes custom.

## Modelo multi-replica (P1)

O hub combina **estado local por processo** com um **adapter Redis apenas para
rooms/broadcast** do Socket.IO. Nao confunda os dois planos.

### Process-local (nao atravessa replicas)

Estes mapas e lookups vivem na memoria de cada processo Node; lookups como
`findAgentBridgeSocketById` / `findConsumerSocketById` devolvem apenas sockets
ligados **a essa instancia**:

- `agentRegistry` e presenca/readiness do agente
- `rpc_bridge`: pending requests REST/legacy, filas relay por agente, buffers
  de stream, circuit breaker local
- `conversationRegistry` e idempotencia relay por conversa
- rate limits Socket quando `SOCKET_RATE_LIMIT_REDIS_URL` esta vazio (com Redis
  de rate limit, o contador e partilhado, mas conversas/pending continuam locais)

Consequencia: `/consumers` e `/agents` exigem **sticky sessions** (ou afinidade
equivalente) enquanto esse estado nao for externalizado. Um `relay:rpc.request`
sempre e despachado para o socket do agente **no mesmo processo** que detem a
conversa. Se `relay:conversation.start` correr numa replica onde o agente so
aparece via presence Redis noutro hub, a resposta e **503** (sticky affinity) —
distinto de **404** agent offline. Contador:
`plug_socket_relay_conversation_start_remote_hub_total`.

### Redis adapter (rooms-only)

Com `SOCKET_IO_REDIS_ADAPTER_URL`, o Socket.IO usa `@socket.io/redis-adapter`
para sincronizar **rooms e broadcast** entre replicas:

- entrega de `client:custom.*` a subscritores em qualquer replica
- `fetchSockets()` e contagens de recipients distribuidas para fan-out REST/Socket
- joins em rooms (`client:<id>`, `consumer:principal:*`, etc.) visiveis cluster-wide

O adapter **nao** replica registry de agentes, conversas relay nem pending RPC.
Em falha de Redis apos ligacao inicial, o hub volta ao adapter **em memoria** na
instancia afectada, regista metricas (`plug_socket_io_redis_adapter_*`) e tenta
reconectar com backoff. Em `NODE_ENV=production` com URL configurada, falha na
**ligacao inicial** aborta o bootstrap (fail-hard); falhas runtime degradam para
memoria + reconnect.

Metricas relevantes em `GET /metrics`:

- `plug_socket_io_redis_adapter_url_configured` / `_active`
- `plug_socket_io_redis_adapter_connection_events_total`
- `plug_socket_io_redis_adapter_fallback_events_total`
- `plug_socket_io_redis_adapter_runtime_errors_total`
- `plug_socket_io_redis_adapter_attached_servers_total`

Ver tambem `docs/studies/scaling_and_roadmap.md` e `docs/configuration.md`.

### `relay:conversation.ended.reason`

Valores publicos documentados:

- `consumer_ended`: o proprio consumer encerrou a conversa com `relay:conversation.end`
- `agent_disconnected`: o socket do agente caiu enquanto a conversa ainda existia
- `expired`: a conversa foi removida pelo idle timeout

Quando o agente desconecta com RPCs relay pendentes ou streams abertos, o hub
notifica o consumer **antes** de limpar rotas:

- unary pendente → `relay:rpc.response` com erro JSON-RPC (`error.data.code =
  "AGENT_DISCONNECTED"`, `retryable: true`)
- stream ativo → `relay:rpc.complete` terminal (`terminal_status: "error"`,
  `error_code: "AGENT_DISCONNECTED"`)

No encerramento explicito (`consumer_ended`), o hub emite `relay:conversation.ended`
ao consumer e tambem ao agente ligado, em modo best-effort.

`consumer_disconnected` pode existir como razao **interna** de cleanup do hub, mas
nao deve ser tratado como contrato publico para SDKs.

## Contrato RPC e metodos suportados

O consumer deve enviar payloads que sigam o contrato do plug_agente. Referencia:
`plug_agente/docs/communication/socket_communication_standard.md`.

**Metodos suportados:** `sql.execute`, `sql.executeBatch`, `sql.bulkInsert`, `sql.cancel`, `rpc.discover`, `agent.getHealth`, `agent.getProfile`, `client_token.getPolicy`.

**Opcoes relevantes em `sql.execute`:** `execution_mode` (`managed` | `preserve`),
`preserve_sql` (alias legado), `page`, `page_size`, `cursor`, `multi_result`,
`prefer_db_streaming`, etc. Em `sql.executeBatch`, o hub tambem aceita
`max_parallel_read_only_batch_items` como pass-through para o agente.

O servidor valida o payload com o schema do bridge (mesmas regras por comando do REST; no relay apenas comando unico) antes de encaminhar, incluindo **tetos UTF-8** do JSON logico (`sql` ate 1 MiB em `sql.execute`, `params` nomeado serializado ate 2 MiB, `agent.getHealth` / `agent.getProfile` / `client_token.getPolicy` / `rpc.discover` `params` ate 64 KiB — ver `docs/api/api_rest_bridge.md`). A ordem pratica no `/consumers` ficou assim:

- validacao barata de envelope JSON acontece antes do rate limit fixo
- validacao profunda do `PayloadFrame` / JSON-RPC pode ocorrer depois do `allowRelayRpcRequest`
- se essa validacao profunda falhar com erro `400` marcado como refundavel, ou se o pedido cair em dedupe (`deduplicated: true`), o hub **devolve a quota consumida** na janela do consumer
- `sql.bulkInsert` valida antes do `PayloadFrame` os tetos
  `AGENT_SQL_BULK_INSERT_MAX_ROWS` e `AGENT_SQL_BULK_INSERT_MAX_JSON_BYTES`;
  cargas maiores devem ser quebradas em lotes pelo cliente

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

- validacao estrutural do envelope recebido (agente/consumer â†’ hub) alinhada ao schema `payload-frame.schema.json` do plug_agente: `schemaVersion` **1.0**, `contentType` **application/json**, inteiros nao negativos, sem chaves desconhecidas no raiz; bloco `signature` sem propriedades extra (`isPayloadFrameEnvelope` em `payload_frame.ts`)
- compressao de saida: acima do limiar, modo **automatico** (gzip so quando a economia supera `PAYLOAD_FRAME_AUTO_GZIP_MIN_SAVINGS_BYTES` e nao viola a razao maxima de inflacao) no hub por defeito; `payloadFrameCompression: always` prefere gzip como no agente “sempre GZIP”, mas cai para `cmp: none` se o frame violaria a guarda de inflacao
- para JSON UTF-8 **acima do teto configuravel** (`PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES`, defeito **512 KiB**), o hub **nao tenta** gzip na codificacao interna (`preencodePayloadFrameJson` em `payload_frame.ts`); o frame segue com `cmp: none` ate ao limite de `10 MB` no fio
- limites de despacho (`max_rows`, `max_batch_size`) seguem politica efetiva por agente: o hub aplica o minimo entre o contrato anunciado e limites declarados pelo agente nas capabilities, quando presentes. `max_concurrent_streams` permanece informativo no handshake nesta fase.
- limite de payload comprimido: `10 MB`
- limite de payload decodificado: `10 MB`
- limite de inflacao gzip: `10x`
- frames inbound **sem** `signature` continuam aceitos por defeito; a verificacao e
  aplicada apenas quando a assinatura vem presente no envelope
- se `signature` vier no frame, o servidor valida com `PAYLOAD_SIGNING_KEY`
  ativo ou com uma chave anterior em `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON`
  (somente inbound). Quando `PAYLOAD_SIGNING_KEY_ID` ou keyring anterior esta
  configurado, `signature.key_id` passa a ser **obrigatorio** e validado;
  ausente ou desconhecido falha com `-32001` (`invalid_signature`). Sem key id
  e sem keyring anterior, deployments single-key continuam aceitando assinaturas
  sem `key_id`. Ver `payload-frame.schema.json` no `plug_agente`.
- apos decodificar o `PayloadFrame`, o hub valida logicamente `rpc:response`,
  `rpc:chunk`, `rpc:complete`, `rpc:request_ack` e `rpc:batch_ack` conforme
  `SOCKET_AGENT_INBOUND_CONTRACT_VALIDATION` (`strict`, `warn`, `off`).
- `rpc:response` batch inbound aceita no maximo 32 itens (`HUB_MAX_BATCH_SIZE`)
  e cada item com `error` deve conter `error.code` inteiro e `error.message`
  string, alinhado ao schema JSON-RPC publicado para o agente.
- se `rpc:response` chegar com frame invalido mas com `requestId` identificavel no
  envelope, o hub encerra a request relay correlacionada com erro JSON-RPC framed
  em vez de esperar apenas por timeout
- se `rpc:response` chegar como batch JSON-RPC (`[]`) para rotas relay, o hub
  rejeita o batch por rota com erro `RELAY_BATCH_RESPONSE_UNSUPPORTED` e nunca
  encaminha o array original ao consumer; batch response permanece permitido no
  fluxo REST/legado quando houver pending request compativel
- se `rpc:chunk` ou `rpc:complete` chegarem com frame invalido mas com `requestId`
  identificavel no envelope, o hub encerra o stream relay com `relay:rpc.complete`
  terminal (`terminal_status: "error"`) em vez de deixar o consumer pendurado

## Correlacao de IDs no relay

- O `id` JSON-RPC enviado pelo consumer e tratado como `client_request_id`
  para idempotencia por conversa.
- O servidor gera um `requestId` interno (UUID) usado no **envelope**
  PayloadFrame e em `meta.request_id` no caminho para o agente.
- **Opcao B (default / agentes legados):** o hub sobrescreve `body.id` com o
  UUID interno ao despachar ao agente e **restaura** o `client_request_id` no
  `body.id` da resposta antes de `relay:rpc.response`. Isso mantem JSON-RPC 2.0
  §5 no consumer e e obrigatorio para `fastPath: true` sem negociacao.
- **Opcao A (negociada):** quando o agente anuncia `extensions.clientRequestIdEcho: "v1"`,
  o hub **nao** sobrescreve `body.id` — preserva o id do consumer end-to-end e
  pode saltar o re-encode (`canBypassReencode`). Ver
  [ADR 0009](../adrs/0009-client-request-id-echo.md).
- Historico do defeito / racional: [`01_relay_body_id_echo.md`](../plug_agente/01_relay_body_id_echo.md).
- Respostas `relay:rpc.response/chunk/complete` correlacionam pelo `requestId`
  interno no **envelope PayloadFrame** (`envelope.requestId`) — fonte de verdade
  wire-level e `correlation_id` em erros sinteticos.
- Metrica: `plug_socket_relay_body_id_echo_total` incrementa quando houve
  reescrita real de `body.id` (caminho Opcao B).

### Caso degenerate: consumer sem `id` JSON-RPC

Por contrato, `relay:rpc.request` **rejeita** notifications (`id: null`)
explicitamente — o handler valida via `hasNotificationCommand` e devolve
`relay:rpc.accepted { success: false, error: { code: "BAD_REQUEST" } }`.

O caso degenerate residual e: consumer envia o request **sem** o campo
`id` no JSON-RPC body. Hoje isso e bloqueado por `bridgeSingleCommandSchema`
(que exige `id` para metodos nao-notification), entao na pratica nao
acontece. Defensivamente, o `resolveOutboundBodyId` no hub
(`rpc_bridge_agent_inbound.ts`) faz fallback para o `requestId` interno
se `clientRequestId` for `undefined`, mantendo o `body.id` da resposta
preenchido com o UUID do hub. Isso garante que erros sinteticos
construidos antes do dispatch (decode failure, etc.) tambem tenham um
`body.id` valido mesmo sem `client_request_id` resolvido.

Comportamento esperado:

| consumer enviou | `body.id` na resposta | `envelope.requestId` |
| --------------- | --------------------- | -------------------- |
| `id: "client-X"` | `"client-X"` (echo) | `"hub-Y"` (UUID interno) |
| `id: 42` (numero) | `42` (echo) | `"hub-Y"` (UUID interno) |
| `id` omitido | `"hub-Y"` (fallback) | `"hub-Y"` (mesmo valor) |
| `id: null` | **rejeitado** (`BAD_REQUEST`) | n/a |
| metodo invalido | erro sintetico com `body.id` = `client-X` se enviado, senao `hub-Y` | `"hub-Y"` |

A metrica `plug_socket_relay_body_id_echo_total` so incrementa quando
**houve** uma reescrita real (`body.id !== envelope.requestId`).

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

### Relay unary fast-path (`fastPath` no envelope)

`relay:rpc.request` aceita o campo opcional `fastPath: boolean` no envelope
(alem de `conversationId`, `frame`, `payloadFrameCompression?` e
`requestServerTimings?`). Quando `true`, o hub **nao emite** `relay:rpc.accepted`
no caminho feliz unary — o consumer ve diretamente `relay:rpc.response` (ou
`relay:rpc.chunk` / `relay:rpc.complete` se a resposta abrir um stream).

Salva-se uma viagem de wire por RPC. Em `mergeAll` cross-agent o ganho compoe
proporcionalmente ao numero de RPCs por onda.

Regras do contrato:

- `fastPath` aplica-se apenas ao caminho feliz **nao-deduplicado**. Quando o
  hub determina que o request e duplicado de outro `client_request_id` (cached
  ou in-flight) ele continua emitindo `relay:rpc.accepted` para sinalizar
  `deduplicated/replayed/inFlight` — o cliente nao tem como reconstruir esse
  estado a partir do `relay:rpc.response` cacheado original. Isso preserva
  diagnostico sem custo extra no caminho comum.
- Erros (validacao, conversa nao encontrada, autorizacao, rate-limit, etc.)
  **sempre** sao reportados via `relay:rpc.accepted { success: false, error }`
  mesmo com `fastPath: true`. Caso contrario o consumer ficaria sem sinal.
- Para **metodos streaming-capable** (`sql.execute` com `prefer_db_streaming` ou
  `multi_result`, `sql.executeBatch`), o hub **rejeita** `fastPath: true` no
  dispatch com `BAD_REQUEST` em `relay:rpc.accepted` (`fastPath is not
  allowed for streaming-capable RPC methods`). O handshake de window/credit
  (`relay:rpc.stream.pull`) precisa do `requestId` ancorado por
  `relay:rpc.accepted` antes do primeiro pull. Metrica:
  `plug_socket_relay_fast_path_stream_inadvertent_total` continua a cobrir
  respostas que abrem stream apesar de `fastPath` (caminhos legados ou race).
- O cliente deve estar preparado para receber `relay:rpc.response` **antes**
  ou **sem** ter recebido `relay:rpc.accepted` quando enviou `fastPath: true`.
  - O `body.id` da resposta JSON-RPC carrega o **`client_request_id`** original
    (= JSON-RPC `id` enviado pelo consumer), conforme JSON-RPC 2.0 §5. E
    seguro rotear a resposta direto pelo `id` que o consumer mantém em seu
    mapa de pendings.
  - O envelope PayloadFrame (`envelope.requestId`) continua sendo o UUID
    interno do hub, util para correlacionar com `correlation_id` em logs
    de ops.
  - Veja [`docs/plug_agente/01_relay_body_id_echo.md`](plug_agente/01_relay_body_id_echo.md)
    para o racional do fix (issue Colmeia `relay_unary_fast_path.md §1`).

Sem cancelamento explicito: o relay nao possui evento `relay:rpc.cancel`.
Cancelamento opera via desconexao do socket consumer (`abort` no inflight) ou
via comando `sql.cancel` com o `stream_id` retornado para streams ativos.
Nenhum dos dois depende do `requestId` ancorado por `relay:rpc.accepted`, entao
`fastPath` nao afeta o cancelamento.

### Server-side phase diagnostics (`requestServerTimings` no envelope)

`relay:rpc.request` aceita o campo opcional `requestServerTimings: boolean` no
envelope. Quando `true`, o hub anexa um snapshot de latencias por fase ao
**JSON-RPC `meta`** da resposta antes de codificar o `PayloadFrame` de saida.

Forma do envelope:

```json
{
  "meta": {
    "serverTimings": {
      "schemaVersion": 1,
      "phasesMs": {
        "consumer_frame_decode_ms": 0.42,
        "relay_preflight_ms": 0.13,
        "encode_ms": 0.85,
        "emit_to_socket_ms": 0.07,
        "agent_to_hub_ms": 142.1,
        "inbound_decode_ms": 0.41,
        "pending_resolve_ms": 0.18,
        "relay_forward_to_consumer_ms": 0.06
      }
    }
  }
}
```

Regras do contrato:

- `schemaVersion` espelha `BRIDGE_LATENCY_PHASES_SCHEMA_VERSION` no hub.
  Atualmente `1`. Novas fases podem ser adicionadas em versoes minor; consumers
  **devem** tolerar chaves desconhecidas.
- Todos os valores estao em **milissegundos**, com arredondamento a 3 casas
  decimais (mesma precisao usada na persistencia em DB).
- O snapshot e capturado **logo antes** do encode da resposta de saida — inclui
  o tempo do hub→consumer forwarder ate o instante do snapshot.
- O custo de payload e ~120 bytes por resposta. O opt-in evita inflar consumers
  de alto throughput que nao consomem timings.
- Quando `requestServerTimings` esta ativo, o hub **forca** a criacao da sessao
  de trace mesmo que `BRIDGE_LATENCY_TRACE_ENABLED=false` — para honrar o
  opt-in. A persistencia em DB continua respeitando a amostragem global.
- No caminho de **dedup-replayed** (resposta cacheada do request original), o
  envelope refletira as timings do request original, nao do duplicado. E
  intencional: o hub reutiliza o frame cacheado para evitar reprocessar.
- **Seguranca:** apenas valores de tempo sao expostos. `trace_id`,
  `agentSocketId`, identificadores de fila e qualquer outro campo de topologia
  operacional **nao** sao incluidos (vide
  `application/services/server_timings_envelope.ts`).

#### `meta.agent_phases` (agente, opt-in via extensao)

Quando o consumer enviou `requestServerTimings: true` **e** o agente negociou
`extensions.agentPhaseTimings: "v1"` em `agent:register`, o hub repassa
`meta.agent_phases` do agente no `relay:rpc.response` sem mutacao (ver
[ADR 0012](../adrs/0012-agent-phase-timings.md)).

Desde 2026-07-07 o hub aplica um **gate defensivo**: se o agente enviar
`meta.agent_phases` sem ter negociado `agentPhaseTimings`, o campo e removido
antes do encode de saida (`isAgentPhaseTimingsNegotiated` em
`relay_route_response_forwarder.ts`). O agente ja auto-gateia em builds recentes;
esta regra protege consumers de agentes legados ou mal configurados.

**Acao no `plug_agente`:** nenhuma mudanca obrigatoria — continuar a anunciar
`agentPhaseTimings: "v1"` apenas quando o suporte estiver ativo.

### Relay JSON-RPC batch (`relay:rpc.request.batch`)

> **Disponivel em v1** desde 2026-05-28; gated por `SOCKET_RELAY_BATCH_ENABLED`
> (default `false`). Ver `docs/adrs/0008-relay-batch-protocol.md` para o
> registro de decisoes e
> `docs/runbooks/socket_perf_investigation.md` para o procedimento de
> medicao de adocao.

Variante batch do `relay:rpc.request` que permite ao consumer empacotar 1..N
JSON-RPC requests em um unico envelope, eliminando a sobrecarga de N emits
no canal `relay:rpc.request`. O ganho aparece principalmente em `mergeAll`
cross-agent.

Envelope JSON (mesma forma do single, com `frame.data` carregando array):

```text
event: relay:rpc.request.batch
payload (JSON):
{
  conversationId: string,
  frame: PayloadFrame,                 // payload.data = JSON-RPC array (1..32 items)
  payloadFrameCompression?: "default" | "none" | "always",
  requestServerTimings?: boolean,
  fastPath?: boolean
}
```

`requestServerTimings` e `fastPath` no envelope propagam para **cada item**
do batch (mesma semantica do `relay:rpc.request` single). ADR Decision B
continua valendo: o hub sempre emite `relay:rpc.batch_accepted` uma vez;
nunca emite `relay:rpc.accepted` por item.

Resposta: `relay:rpc.batch_accepted` (JSON, **uma vez por envelope**):

```text
{
  success: true,
  conversationId: string,
  batchSize: number,
  items: [
    {
      clientRequestId: string,
      requestId: string,
      deduplicated?: boolean,
      replayed?: boolean,
      inFlight?: boolean
    },
    // OU, em caso de erro per-item:
    {
      clientRequestId: string,
      error: { code, message, statusCode?, itemIndex }
    },
    ...
  ]
}
```

Em rejeicao do envelope (sem dispatch de itens):

```text
{
  success: false,
  error: {
    code: "RELAY_BATCH_DISABLED" | "BATCH_TOO_LARGE" | "BATCH_EMPTY"
        | "BATCH_ITEM_INVALID" | "BATCH_ITEM_REQUIRES_ID" | "BATCH_DUPLICATE_ID"
        | "BATCH_STREAMING_ITEM_REJECTED" | "RATE_LIMITED" | "NOT_FOUND"
        | "BAD_REQUEST" | "VALIDATION_ERROR",
    message: string,
    statusCode?: number,
    details?: Record<string, unknown>
  }
}
```

Per-item responses continuam chegando via **`relay:rpc.response` existente**
— um por item, correlacionados via `requestId` na envelope ou `id` no
JSON-RPC body. A relacao `clientRequestId → requestId` para cada item esta
**inteira** no `batch_accepted.items[]` para correlacao no client.

### Regras do contrato v1

- **Cap de items**: 1..`SOCKET_RELAY_BATCH_MAX_ITEMS` (default `32`). Excede
  retorna `BATCH_TOO_LARGE`.
- **Cada item DEVE ter JSON-RPC `id`** (notifications NAO suportadas em v1).
  Faltando retorna `BATCH_ITEM_REQUIRES_ID`.
- **IDs DEVEM ser unicos** dentro do batch. Duplicados retornam
  `BATCH_DUPLICATE_ID`.
- **Streaming-capable items rejeitados** (`sql.executeBatch`,
  `sql.execute` com `prefer_db_streaming: true` ou `multi_result: true`)
  com `BATCH_STREAMING_ITEM_REJECTED` (carrega `details.itemIndex` e
  `details.method`).
- **Per-socket inflight gate all-or-nothing**: se o batch precisa de N
  slots e so K < N estao disponiveis, rejeita o envelope inteiro com
  `RATE_LIMITED` carregando `details.availableSlots` e `details.requestedSlots`.
  Nenhum item e despachado. O cliente pode retentar com batch menor.
- **Rate limit proporcional**: `relay:rpc.request.batch` consome
  `items.length` creditos do orçamento `SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS`
  (um credito por item). Itens deduplicados no `batch_accepted` devolvem quota
  via refund batched (`refundRelayRpcRequestAsync`). Rejeicao por quota no
  envelope inteiro incrementa
  `plug_socket_relay_batch_envelopes_rejected_total{reason="rate_limited"}`.
- **Per-agent dispatch slot** continua sendo per-item: itens do mesmo
  agente serializam internamente na fila `SOCKET_RELAY_AGENT_MAX_INFLIGHT`.
- **Idempotency runs per item**: se um `client_request_id` colide com uma
  entrada cacheada/inflight, esse item especifico vem com
  `deduplicated/replayed/inFlight` no `batch_accepted.items[k]`. Os outros
  continuam normalmente. Partial dedup e o caminho feliz.
- **Falha per-item nao aborta o batch**: cada item resolve independentemente.
  Erros aparecem em `batch_accepted.items[k].error`; sucessos aparecem em
  `batch_accepted.items[k].requestId`.

### Metricas relacionadas em `/metrics`

- `plug_socket_relay_batch_envelopes_received_total`
- `plug_socket_relay_batch_envelopes_accepted_total`
- `plug_socket_relay_batch_items_accepted_total`
- `plug_socket_relay_batch_items_deduped_total`
- `plug_socket_relay_batch_items_error_total`
- `plug_socket_relay_batch_envelopes_rejected_total{reason="disabled|not_found|frame_decode_failed|not_array|validation_failed|inflight_gate|rate_limited|envelope_error"}`
- `plug_socket_relay_batch_envelope_decode_avg_ms` / `_max_ms` (gauge por processo)
- `plug_socket_relay_batch_items_per_envelope_avg` / `_max` (gauge por processo)

Dashboard Grafana: [`docs/grafana/relay_batch_dashboard.json`](../grafana/relay_batch_dashboard.json).

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
  reenviados ao consumer quando aplicavel. Se o ACK nao chega, o hub reemite o
  mesmo `rpc:request` apenas quando a request e elegivel: relay com
  `client_request_id`, REST/`agents:command` de leitura segura ou com
  `params.idempotency_key` em todos os itens. Notifications, batches
  parcialmente elegiveis, requests ja respondidas, socket desconectado e pending
  removido nunca sao reemitidos.
- `rpc:batch_ack` inbound aceita no maximo 32 `request_ids`. No relay, o hub
  agrupa o ACK por consumer e encaminha apenas os IDs pertencentes a cada
  consumer.
- Timeout de relay request: quando o agente nao responde no prazo, o servidor
  devolve erro JSON-RPC no `relay:rpc.response`. A rota fica marcada
  `timedOut` e `settled`; respostas do agente que chegarem **depois** sao
  descartadas (o consumer ja recebeu o timeout). Metrica:
  `plug_socket_relay_late_response_after_timeout_total` (tombstone preserva a
  contagem mesmo apos a rota ser removida).
- **Settlement atomico**: cada rota relay usa flag `settled` para garantir que
  apenas um terminal vence (timeout, sucesso unary, `relay:rpc.complete` ou
  disconnect do agente/consumer). Evita dupla entrega timeout + resposta tardia.
- **Idempotencia sem TOCTOU**: a entrada in-flight de idempotencia e gravada
  antes do `await` de dispatch; entradas in-flight expiradas sao podadas quando
  a rota ja nao existe.
- **Reserva atomica de pending**: slots de pending por conversa/consumer sao
  reservados antes do dispatch (`reserveRelayPendingSlot`) para fechar corrida
  com o cap global.
- Timeout de stream aberta: quando `rpc:response` abre `stream_id`, o slot de
  dispatch do agente e liberado e a stream passa a ser controlada pelos limites
  de streams/buffer/creditos. Se nao houver atividade ate
  `SOCKET_RELAY_STREAM_IDLE_TIMEOUT_MS`, ou se a stream ultrapassar
  `SOCKET_RELAY_STREAM_MAX_LIFETIME_MS`, o hub remove rotas/flow state e emite
  `relay:rpc.complete` com `terminal_status: "error"` e
  `error_code: "RELAY_STREAM_TIMEOUT"`.
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
- **Chunks tardios apos `rpc:complete`**: o hub descarta `rpc:chunk` que chegam
  depois do terminal do agente (`completeReceived`); regista log
  `relay_chunk_after_complete_dropped` (contador interno
  `chunkAfterCompleteDroppedTotal`).
- **Backpressure no transporte consumer**: quando
  `SOCKET_RELAY_CONSUMER_TRANSPORT_MAX_BUFFERED_BYTES` > 0, apenas a emissao de
  `relay:rpc.chunk` (drains de stream) pausa enquanto o buffer de escrita
  Socket.IO do consumer exceder o teto; eventos de controlo (`request_ack`,
  `response`, `complete`) continuam a ser emitidos. Emissao que falha por
  consumer desligado incrementa
  `plug_socket_relay_emit_discarded_consumer_gone_total`.
- Buffer com limites: chunks sao bufferizados por request e globalmente com caps
  de quantidade e bytes para evitar explosao de uso; se o agente exceder esse buffer, o hub
  fecha o stream com `relay:rpc.complete` terminal (`terminal_status: "aborted"`)
  em vez de descartar chunks silenciosamente.
- Pull capability-aware: o hub **publica** os hints
  `recommendedStreamPullWindowSize` e `maxStreamPullWindowSize` (derivados de
  `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` e do limite maximo
  (`SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE`) em `agent:capabilities.extensions`
  para o agente calibrar `rpc:stream.pull` sem heuristica propria; o hub garante
  `recommendedStreamPullWindowSize <= maxStreamPullWindowSize`; o hub sempre
  aplica `SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE` como teto final e, quando o
  agente anuncia um teto menor em `extensions` ou `limits`, aplica tambem esse
  clamp tanto no pull interno quanto nas requests do consumer
  (`agent_registry.resolveStreamPullWindow`).
- Quotas de protecao: limites para conversas, pending requests por conversa e
  por consumer.
- Limpeza por inatividade: conversas inativas expiram automaticamente por TTL.
- Fila outbound por `requestId`: respostas unary e erros sinteticos passam por
  `enqueueRelayOutbound` para preservar ordenacao por pedido. Se o job de saida
  falhar no encode/emit **apos** o timeout da rota ter sido cancelado, o hub
  tenta (best-effort) emitir um `relay:rpc.response` sintetico com
  `error.data.code = "BRIDGE_OUTBOUND_PROCESSING_FAILED"` e `retryable: true`
  antes de limpar a rota — evita hang silencioso no consumer. Metrica:
  `plug_socket_relay_outbound_job_failure_notified_total` (so incrementa quando
  o emit sintetico teve sucesso; se o encode sintetico tambem falhar, o consumer
  pode ficar sem resposta).
- Metricas em memoria: o servidor registra contadores de throughput, timeout,
  dedupe, perdas por backpressure e terminais explicitos de stream.

Configuracao via variaveis de ambiente em `.env.example`.

Variaveis principais do relay:

- `SOCKET_RELAY_REQUEST_TIMEOUT_MS`
- `SOCKET_RELAY_STREAM_IDLE_TIMEOUT_MS`
- `SOCKET_RELAY_STREAM_MAX_LIFETIME_MS`
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
- `SOCKET_RELAY_MAX_BUFFERED_BYTES_PER_REQUEST`
- `SOCKET_RELAY_MAX_TOTAL_BUFFERED_BYTES`
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

Valores default, envelopes HTTP/Socket ao atingir quotas e Nginx edge:
[`docs/limits/limites_acesso_e_quotas.md`](../limits/limites_acesso_e_quotas.md)
e [`docs/configuration.md`](../configuration.md).

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

### Refund de quota apos consumo (`relay:conversation.start`, `relay:rpc.request`)

Depois de a quota da janela fixa ser consumida (em
`register_consumer_socket_handlers.ts`, apos validacao barata do envelope),
falhas no handler podem **devolver** o hit na janela
(best-effort via `refundRelayConversationStartAsync` / `refundRelayRpcRequestAsync`;
com Redis, scope `relay_conversation_start` / `relay_rpc_request`):

- **Devolve quota**: erros **transientes** ou inesperados (nao-`AppError`),
  `AppError` fora do intervalo 4xx (ex.: `503` / `SERVICE_UNAVAILABLE`,
  agente indisponivel, fila cheia, disconnect do consumer antes de concluir) e,
  somente em `relay:rpc.request`, `AppError` **400** marcado internamente como
  validacao profunda refundavel do `PayloadFrame` / JSON-RPC depois do
  `allowRelayRpcRequestAsync`.
- **Nao devolve**: `401`, `403`, `404`, `409`, `429` e demais **4xx** que nao
  sejam o `400` profundo marcado de `relay:rpc.request` (404 agente/conversa
  inexistente, 409 teto por consumer, forbidden, capability/compressao
  incompatível, etc.).
- **Antes do consumo**: `VALIDATION_ERROR` no envelope e `429` do proprio
  limitador (`allow === false`) **nao** consomem quota.
- **`relay:rpc.request` — casos extra**: `429` por inflight partilhado por socket
  (`SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`) **mantem** a quota (4xx); aceite
  idempotente (`deduplicated: true`) **devolve** no caminho de sucesso porque
  nao houve novo dispatch.
- **`relay:rpc.request.batch` — casos extra**: o custo proporcional da janela e
  consumido **dentro** do handler (depois de validar o array). Se o gate de
  inflight all-or-nothing falhar (`429`), o hub **devolve** esse custo
  proporcional — distinto do unary, onde o `allow` corre no wiring antes do
  inflight. Preferir o batch quando o consumer precisa de refund previsivel
  sob pressão de inflight.
- **`relay:conversation.start` — casos extra**: `429` por inflight partilhado
  apos consumir a quota de start **mantem** a quota (mesmo padrao do unary RPC).

O `400` profundo marcado de `relay:rpc.request` e uma excecao deliberada a
paridade geral com `socket:event.publish` para evitar cobrar quota por payloads
rejeitados depois do pre-handler barato.

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
`relay:conversation.start`, `relay:rpc.request`, `relay:rpc.request.batch`,
`agents:stream_pull`, `relay:rpc.stream.pull`, e `socket:event.publish` quando
nao usa o teto dedicado) tambem respeitam
`SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`. Acima desse teto o hub responde
`RATE_LIMITED` imediatamente, sem entrar na bridge.

### Shed load em `/consumers`

Se a fila outbound relay exceder backlog ou latência p95 configurados, o hub passa a rejeitar temporariamente novos eventos em `/consumers` com `SERVICE_UNAVAILABLE` e `retryAfterMs`. O gate aplica-se a `relay:conversation.start`, `relay:rpc.request`, `relay:rpc.request.batch`, `relay:rpc.stream.pull`, ao legacy `agents:stream_pull` e a `agents:command`. Variáveis principais:

- `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG`
- `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS`
- `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG_EXIT` — limiar de saida para backlog (`0` = mesmo valor de entrada, sem histerese)
- `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_EXIT_MS` — limiar de saida para p95 (`0` = mesmo valor de entrada)
- `SOCKET_RELAY_OUTBOUND_TAIL_STALE_MS`
- `SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS`
- `SOCKET_RELAY_CONSUMER_TRANSPORT_MAX_BUFFERED_BYTES` — pausa drains de stream por backpressure de escrita no consumer (`0` desativa)

Metrica de rejeicoes por shedding:
`plug_socket_relay_outbound_queue_overload_rejected_total`.

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
Outbound desse canal usa **`PayloadFrame` por defeito**; inbound aceita JSON
ou frame durante a transicao — ver
[`socket_client_sdk.md`](socket_client_sdk.md) ("Migração PayloadFrame no bridge legado")
e `SOCKET_AGENTS_COMMAND_COMPAT_MODE` em `docs/configuration.md`.

O mesmo contrato de comando ao agente existe em **paralelo** via
`POST /api/v1/agents/commands` (REST): o cliente pode usar **só REST**, **só Socket**
ou **combinar** (ex.: auth HTTP + comandos Socket). O REST **nao** expoe streaming
progressivo ao cliente (materializacao no hub); ver `docs/PROJECT_OVERVIEW.md`
(_Dois canais para comandos ao agente_).

## SDK cliente

Exemplo minimo de cliente relay:

- `docs/socket/socket_client_sdk.md`
