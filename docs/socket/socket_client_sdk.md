# Socket Client SDK Minimo (Relay)

> **Action required by 2026-09-30:** Este repositorio nao publica pacote npm/SDK cliente separado. Aplicacoes que consomem Socket devem decodificar `PayloadFrame` em todos os eventos outbound listados abaixo (incluindo `connection:ready`) antes da remocao dos shims `raw_json`. Ver secao _Shims de compatibilidade_ e `docs/configuration.md`.

Data: 2026-05-11

Guia rapido para cliente Socket no modo relay (`/consumers`), com tratamento de
`PayloadFrame` binario + `gzip`.

Este documento cobre transporte e uso do canal Socket. Regras de negocio sobre
ownership de `Agent`, aprovacao de acesso de `Client` e consulta de agentes
aprovados vivem em `docs/api/client_agent_business_rules.md`.
Mapa geral da documentacao: `docs/README.md`.

Este arquivo e pragmatico: mostra como consumir o relay e o bridge Socket na
pratica. O contrato normativo continua em `docs/socket/socket_relay_protocol.md`; para
rotas HTTP e payloads compartilhados com o bridge REST, use o OpenAPI em
`GET /docs` e `GET /docs.json`.

**Canal alternativo (REST):** os mesmos comandos JSON-RPC podem ser enviados por
`POST /api/v1/agents/commands` sem Socket no consumer; o REST **nao** expoe
streaming progressivo (resultado agregado num unico JSON). Para consultas grandes
(`max_rows`/`page_size` altos, relatorios, CTEs, joins largos ou payload esperado
acima de alguns MiB), preferir Socket/relay e sinalizar
`options.prefer_db_streaming=true` para o agente. Ver `docs/PROJECT_OVERVIEW.md`.

**Catalogo de metodos RPC no bridge** (`sql.execute`, `client_token.getPolicy`, `rpc.discover`, etc.), limites UTF-8 e exemplos: `docs/api/api_rest_bridge.md` (fonte normativa partilhada com o REST).

### Producao — alinhamento Colmeia (smoke)

- **`SOCKET_CONSUMER_ROLES`**: o default em `env.ts` e `user,admin,client`. Se a env listar apenas `user,admin` (sem o literal `client`), o parse **acrescenta** `client` automaticamente (`parseSocketConsumerRolesValue`); o arranque pode registar `INFO` `socket_consumer_roles_ensured_client`. Para Colmeia, garantir que o JWT de `Client` usa `role=client` e que esse papel nao foi removido por configuracao anomala (o runtime nunca remove `client` apos o parse).
- **`SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED`**: `true` ou omitido; `false` remove o push `client:agent.profile.updated`. O fan-out usa cache local limitado por `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS` (default `1000`) e `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE` (default `5000`).
- **Handshake `/consumers`**: exige JWT valido mesmo que `SOCKET_AUTH_REQUIRED=false` noutros canais; nao existe modo anonimo suportado para operacao real do namespace.
- **Capacidade ao conectar (principal `client`)**: `connection:ready` sai cedo, depois do hub entrar nas rooms base de identidade (`principal` e `client`). As rooms derivadas por acesso aprovado (`consumer:client-agent:*` e `consumer:agent-profile:*`) sao preenchidas de forma assincrona logo apos o ready, com dedupe por `clientId` para evitar rajadas em reconnect storm. Durante essa janela curta, `grantClientAccess` e o reconcile periodico garantem convergencia; clientes que precisam do catalogo completo devem usar os endpoints REST de listagem como fonte de verdade e tratar pushes iniciais como best-effort.
- **REST offline**: `POST /api/v1/agents/commands` com `id` correlacionável e agente conhecido em memória mas sem socket → **HTTP 200** e `response.item.error` com `code: -32000`, `message: agent_offline`, `data.reason: agent_disconnected_at_dispatch` (não confundir com **503** de overload / notification-only / disconnect a meio de request).
- **`X-Hub-Instance-Id`**: deploy de instância única — `docs/infrastructure/nginx_production.md` (secção **13) Upstream e `X-Hub-Instance-Id`**) e checklist em `docs/configuration.md` (_Checklist produção_).

## Eventos e formato

- **Handshake**: `connection:ready` (PayloadFrame; contrato e compat detalhados em `docs/socket/socket_relay_protocol.md` -> _Handshake: `connection:ready`_). Quando esse evento chega para principal `client`, a room base `client:<clientId>` ja foi associada; rooms derivadas por agente aprovado convergem logo depois em backfill assincrono.
- Controle em JSON: `relay:conversation.*`, `relay:rpc.accepted`, `relay:rpc.stream.pull_response`, acks `socket:event.*`
- Dados em `PayloadFrame`: `connection:ready`, `agents:command_response`, `agents:command_stream_chunk`, `agents:command_stream_complete`, `agents:stream_pull_response`, `relay:rpc.request`, `relay:rpc.response`, `relay:rpc.chunk`, `relay:rpc.complete`, `relay:rpc.request_ack`, `relay:rpc.batch_ack`, `relay:rpc.stream.pull`
- **Bridge legado (`agents:*`)**: inbound `agents:command` e `agents:stream_pull` aceitam plain JSON **ou** `PayloadFrame` durante a transicao; outbound de respostas e stream usa `PayloadFrame` por defeito. Ver _Migração PayloadFrame no bridge legado_ abaixo e shims em `docs/configuration.md`.
- **Push de catalogo (role `client`, acesso aprovado ao agente):** `client:agent.profile.updated` em `PayloadFrame` quando o perfil catalogado desse agente muda (HTTP/socket/pull sync no hub). Payload tipico: `agent_id`, `profile_version`, `profileUpdatedAt`, `changed_fields`, `source`. Regras de acesso: `docs/api/client_agent_business_rules.md`.
- **Pub/sub customizado:** apenas tokens de **Client** no `/consumers` podem assinar `client:custom.*` com `socket:event.subscribe` / `socket:event.unsubscribe`; publicacoes com o mesmo tipo de token chegam ao `eventName` em `PayloadFrame` via **`POST /api/v1/client/me/socket-events`** (REST) ou **`socket:event.publish`** (Socket; ack em `socket:event.published`). `socket:event.*` revalida conta ativa por evento; conta bloqueada recebe erro no envelope atual e o socket e desconectado de forma controlada. Principais `user`/`admin` que emitam `socket:event.*` recebem `403` no ack **sem** disconnect (mantêm relay / `agents:*`).

## Estrutura do PayloadFrame

```ts
type PayloadFrame = {
  schemaVersion: "1.0";
  enc: "json";
  cmp: "none" | "gzip";
  contentType: "application/json";
  originalSize: number;
  compressedSize: number;
  payload: Uint8Array | number[] | string;
  traceId?: string;
  requestId?: string;
  signature?: { alg: "hmac-sha256"; value: string; key_id?: string };
};
```

Em alguns eventos de **alto debito** (`relay:rpc.chunk`, `relay:rpc.complete`, acks relay), o servidor pode omitir `traceId` no envelope; usar `requestId` para correlacao.

## Pub/sub customizado (REST ou Socket)

Use este fluxo para eventos de aplicacao que nao sao comandos RPC para agente:

1. Conecte no namespace `/consumers` com JWT valido.
2. Assine um evento reservado:

```ts
socket.emit("socket:event.subscribe", {
  requestId: crypto.randomUUID(),
  eventName: "client:custom.status.changed",
});

socket.on("socket:event.subscribed", (ack) => {
  if (!ack.success) throw new Error(ack.error.message);
  // Opcional: ack.data?.alreadySubscribed === true → o socket ja estava na room deste eventName.
});
```

No ack de `socket:event.unsubscribed`, use `ack.data?.wasSubscribed` para saber se havia subscricao local antes do `leave` (`false` = unsubscribe idempotente sem estado previo).

3. Publique com token de `Client` — **opcao A: REST** (multipart suportado para anexos):

```http
POST /api/v1/client/me/socket-events
Authorization: Bearer <client-access-token>
Idempotency-Key: publish-status-123
Content-Type: application/json

{
  "eventName": "client:custom.status.changed",
  "payloadFrameCompression": "default",
  "payload": { "status": "ready", "message": "job finished" }
}
```

**Opcao B: Socket** (mesmos limites de tamanho de payload e anexos; anexos inline no JSON). O campo `requestId` e propagado para logs do hub e para o `requestId` do `PayloadFrame` entregue aos subscritores (além do `eventId` unico da emissao). **Ficheiros grandes:** prefira **multipart** no REST (`POST .../socket-events`): `attachments[]` no Socket implica `base64` no JSON e aumenta o tamanho no fio; o hub aplica um teto ao envelope JSON bruto antes do Zod.

```ts
const publishReqId = crypto.randomUUID();
socket.emit("socket:event.publish", {
  requestId: publishReqId,
  idempotencyKey: "publish-status-123",
  eventName: "client:custom.status.changed",
  payloadFrameCompression: "default",
  payload: { status: "ready", message: "job finished" },
});

socket.on("socket:event.published", (ack) => {
  if (ack.requestId !== publishReqId) return;
  if (!ack.success) throw new Error(ack.error.message);
  console.log(ack.data.eventId, ack.data.recipients, ack.data.idempotentReplay);
});
```

O rate limit numerico do Socket usa por defeito `REST_SOCKET_EVENT_RATE_LIMIT_*`, com overrides opcionais `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_*`; o balde Socket e **independente** do balde HTTP (como em `agents:command` vs REST de comandos).

4. Receba o evento dinamico e decodifique o `PayloadFrame`:

```ts
socket.on("client:custom.status.changed", (rawFrame) => {
  const decoded = decodeFrame(rawFrame);
  console.log(decoded.payload, decoded.attachments);
});
```

Para cancelar: `socket.emit("socket:event.unsubscribe", { requestId, eventName })`.
Somente nomes `client:custom.*` sao aceitos. A entrega e global por `eventName`
dentro do hub atual; a resposta REST `recipients` ou o ack `socket:event.published`
indica quantos sockets locais estavam inscritos no momento da publicacao. Em multi-replica sem adapter
Socket.IO distribuido, a publicacao so alcanca sockets da mesma replica.
Use `Idempotency-Key` (REST) ou `idempotencyKey` (Socket) em retries: repetir a mesma chave com o mesmo corpo
retorna a resposta original com `idempotentReplay: true` sem emitir o evento de
novo; repetir a chave com outro corpo retorna `409` (REST) ou `socket:event.published` com `error.code: IDEMPOTENCY_KEY_CONFLICT` (Socket).
A mesma chave e partilhada entre REST e Socket para o mesmo `Client` (JWT `sub`); ver `docs/socket/socket_relay_protocol.md`. Por defeito, cache e fila de serializacao de idempotencia sao **por processo**. Em multi-replica, configure `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL` para replay/conflito e lock distribuido, e `SOCKET_IO_REDIS_ADAPTER_URL` para entregar `client:custom.*` entre replicas. O teto opcional `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` continua por processo. Com TTL de idempotencia `0`, retries **sequenciais** com a mesma chave podem voltar a emitir; com TTL > `0`, o replay guardado cobre esse caso. Um `503` por teto de serializacao ou lock distribuido ocupado inclui `retry_after_ms` alinhado a `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS`.
Se o socket desligar antes do hub responder, o ack `socket:event.published` pode nao ser emitido (o servidor evita escrever num socket ja fechado).
Opcional: `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` > 0 reserva um teto de publicacoes `socket:event.publish` em voo **separado** do teto partilhado `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET` usado por relay e comandos.

Com `SOCKET_IO_REDIS_ADAPTER_URL`, a entrega de `client:custom.*` atravessa
replicas. Se a contagem distribuida de destinatarios falhar, o hub so publica em
modo degradado quando a sala local fica abaixo de
`REST_SOCKET_EVENT_BEST_EFFORT_LOCAL_MAX_RECIPIENTS`; apos falhas consecutivas,
o circuito abre e novas publicacoes recebem `503` retryable. Portanto, trate
`recipients` como melhor esforco em cenarios de degradacao e use retry com
backoff quando o ack REST/Socket vier com `SERVICE_UNAVAILABLE`.

Multipart tambem e aceito: envie o campo `event` com o JSON acima e campos
`files` repetidos. Os anexos sao pequenos e inline, entregues como
`attachments[]` com `originalName`, `mimeType`, `sizeBytes` e `base64`.
Campos de arquivo diferentes de `files` sao rejeitados.

## Limites e comportamento do hub (resumo)

- **Tamanho de frame**: até **10 MiB** comprimido/decodificado no contrato do hub (`payload_frame.ts`); validar no cliente antes de enviar SQL/parametros enormes.
- **Rate limits**: relay (`relay:conversation.start`, `relay:rpc.request`, creditos de `relay:rpc.stream.pull`), `agents:command`, `agents:stream_pull` e `agent:register` tem tetos por janela. Quando `SOCKET_RATE_LIMIT_REDIS_URL` esta configurado, esses limitadores Socket usam Redis com fallback fail-open para memoria; caso contrario ficam locais ao processo. Respostas **429** quando excedido. No relay, dedupe (`deduplicated: true`) e falhas profundas de validacao `400` marcadas como refundaveis nao devem consumir quota final da janela; o hub faz rollback do contador.
- **Retry-After**: erros Socket de overload podem incluir `retryAfterMs`. Em `agents:command_response`, se o agente retornar erro JSON-RPC `-32013` com `error.data.retry_after_ms`, o hub adiciona `retryAfterSeconds`, espelhando o header `Retry-After` do REST. No relay, o frame JSON-RPC do agente continua sendo fonte de verdade; leia `error.data.retry_after_ms`.
- **Helper recomendado**: clientes podem copiar a politica pura de `src/shared/utils/socket_retry_after_policy.ts` para normalizar todos os formatos publicos de retry em milissegundos antes de aplicar backoff com jitter.
- **Streaming relay**: o consumer deve emitir `relay:rpc.stream.pull` com `window_size` para conceder créditos; sem créditos, o hub pode **bufferizar** chunks ate um teto e depois encerrar o stream com `relay:rpc.complete` terminal (`terminal_status: "aborted"`). Se o agente abrir `stream_id` e nunca enviar `rpc:complete`, o hub encerra por idle timeout ou lifetime maximo com `relay:rpc.complete` (`terminal_status: "error"`, `error_code: "RELAY_STREAM_TIMEOUT"`).
- **Consumer idle timeout**: sweeps desligam sockets `/consumers` inactivos apos `SOCKET_CONSUMER_IDLE_TIMEOUT_MS` (defeito 30 min); emite `app:error` com `code: CONSUMER_IDLE_TIMEOUT` antes do disconnect. Apenas eventos **inbound validos iniciados pelo cliente** refrescam `lastSeenAt` (`consumer_idle_touch_events.ts`): `agents:command`, `agents:stream_pull`, `relay:conversation.start/end`, `relay:rpc.request`, `relay:rpc.request.batch`, `relay:rpc.stream.pull`, `socket:event.subscribe/unsubscribe/publish`. Payloads malformados, rejeicoes de overload (`503`) e envelopes invalidos **nao** renovam o relogio. Trafego hub→consumer de alta frequencia (`agents:command_response`, `agents:command_stream_*`, chunks/respostas relay reflectidas, `client:agent.profile.updated`, etc.) **nao** reinicia o relogio idle — receber stream passivo nao mantem a sessao viva. Para sessoes longas com pouco trafego de comando, emitir periodicamente um evento significativo (ex. heartbeat de aplicacao via `agents:command` ou `relay:rpc.request`). Config: `docs/configuration.md` (_Idle enforcement_). Metrica: `plug_consumer_idle_timeout_disconnect_total` — ver `docs/observability/observability.md`.
- **REST vs Socket**: o REST **materializa** streams SQL num único JSON; para muitas linhas ou baixa latência por chunk, usar Socket (legado ou relay).
- **Multi-réplica**: correlação REST e muito estado do bridge são **por processo**; Redis adapter/idempotencia Redis ajudam `client:custom.*`, mas relay/pending/registry ainda precisam de afinidade — ver `docs/studies/scaling_and_roadmap.md`.
- **PayloadFrame signature**: quando o cliente assina frames com HMAC-SHA256, em deployments com `PAYLOAD_SIGNING_KEY_ID` ou `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON` configurado no hub o `signature.key_id` passa a ser **obrigatorio** e validado contra a keyring.

Nota de streaming relay: `relay:rpc.stream.pull` e limitado pelo hub a `SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE` e, quando o agente anuncia teto menor, pelo teto do agente.

## Exemplo de encode/decode no cliente (Node.js)

Alinhado ao modo **automatico** do hub / plug_agente: acima do limiar (4096 bytes UTF-8), usar **gzip so se** o bloco comprimido economizar bytes suficientes face ao JSON bruto (ver `PAYLOAD_FRAME_AUTO_GZIP_MIN_SAVINGS_BYTES`) e nao exceder a razao maxima de inflacao; caso contrario `cmp: "none"`. (No REST/relay, `payloadFrameCompression: "always"` no envelope controla a re-encodacao **hub → agente** apos o servidor descodificar o teu frame, ainda limitada pela guarda de inflacao.)

```ts
import { gzipSync, gunzipSync } from "node:zlib";

const COMPRESSION_THRESHOLD = 4096;
const MAX_INFLATION_RATIO = 10;

const encodeFrame = (data: unknown): PayloadFrame => {
  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  let cmp: "none" | "gzip" = "none";
  let wire: Buffer = encoded;
  if (encoded.length >= COMPRESSION_THRESHOLD) {
    const gz = gzipSync(encoded);
    if (gz.length < encoded.length && encoded.length / gz.length <= MAX_INFLATION_RATIO) {
      wire = gz;
      cmp = "gzip";
    }
  }
  return {
    schemaVersion: "1.0",
    enc: "json",
    cmp,
    contentType: "application/json",
    originalSize: encoded.length,
    compressedSize: wire.length,
    payload: wire,
  };
};

const decodeFrame = (frame: PayloadFrame) => {
  const bytes =
    typeof frame.payload === "string"
      ? Buffer.from(frame.payload, "base64")
      : Buffer.from(frame.payload);
  const decoded = frame.cmp === "gzip" ? gunzipSync(bytes) : bytes;
  if (bytes.length > 0 && decoded.length / bytes.length > MAX_INFLATION_RATIO) {
    throw new Error("PayloadFrame inflation ratio exceeded");
  }
  return JSON.parse(decoded.toString("utf8"));
};
```

**Producao:** o exemplo acima e didatico. Antes de `gunzip` / `JSON.parse`, um cliente robusto deve:
validar `enc === "json"` e `cmp` em `gzip` \| `none`; conferir `bytes.length === compressedSize`;
apos descompressao, `decoded.length === originalSize`; limitar tamanho maximo e **razao de inflacao** (ex.: 10x,
como o hub em `payload_frame.ts` / `decodePayloadFrame`); se existir `signature`, verificar HMAC com a chave
negociada (ver `plug_agente/docs/communication/socketio_client_binary_transport.md`). Encode reutilizavel:
[`docs/snippets/payload_frame_client_encode.ts`](snippets/payload_frame_client_encode.ts).

## Fluxo minimo (chat-like)

1. `relay:conversation.start` com `{ agentId }` ou `{ requestId, agentId }`
2. Recebe `relay:conversation.started` com `conversationId` e o mesmo `requestId` quando enviado
3. Envia `relay:rpc.request` com `{ conversationId, frame }` (opcional: `payloadFrameCompression`: `default` \| `none` \| `always` — `default` = auto: gzip ao agente so se menor que JSON bruto e dentro da guarda de inflacao; `always` = prefere gzip quando elegivel, alinhado ao plug_agente, mas ainda respeita a guarda de inflacao)
4. Recebe `relay:rpc.accepted` (JSON) — **pode ser omitido** se voce setou `fastPath: true`, ver "Opt-ins de performance" abaixo
5. Recebe dados (`relay:rpc.response`, `relay:rpc.chunk`, `relay:rpc.complete`) em `PayloadFrame`
6. Em streaming, envia `relay:rpc.stream.pull` com `{ conversationId, frame }`
7. Finaliza com `relay:conversation.end` (opcionalmente `{ requestId, conversationId }`; o agente tambem recebe `relay:conversation.ended` com `reason: "consumer_ended"`)

## Opt-ins de performance e diagnostico (relay e agents:command)

Dois flags opcionais no envelope reduzem latencia / dao visibilidade sem mudar o contrato base. Ambos sao **opt-in** (`undefined` = comportamento legado preservado).

### `fastPath: boolean` — relay unary fast-path

Aplicavel a `relay:rpc.request`. Quando `true`, o hub **nao emite** `relay:rpc.accepted` no caminho feliz unary. O consumer recebe diretamente `relay:rpc.response` (ou stream events). Salva uma viagem de wire por RPC; o ganho compoe em `mergeAll` cross-agent.

```json
{
  "conversationId": "<conv-id>",
  "frame": "<PayloadFrame>",
  "fastPath": true
}
```

Regras essenciais:

- O cliente **deve** estar preparado para receber `relay:rpc.response` sem ter recebido `accepted` antes. O `requestId` do hub vem no envelope PayloadFrame da resposta e tambem no proprio JSON-RPC.
- Em **dedupe** (`replayed` / `inFlight`), o hub **ainda** emite `accepted` mesmo com `fastPath: true` — preserva diagnostico do dedupe na borda sem custo no caminho comum.
- Em **erros** (validacao, conversa nao encontrada, autorizacao, rate-limit), o hub **sempre** emite `relay:rpc.accepted { success: false, error }`. Caso contrario o consumer ficaria sem sinal.
- Para **metodos streaming-capable** (`sql.execute` com `prefer_db_streaming` /
  `multi_result`, `sql.executeBatch`), **nao** use `fastPath: true`. O hub
  **rejeita** o flag no dispatch com `BAD_REQUEST` em
  `relay:rpc.accepted`. Sem `accepted` para ancorar o `requestId`, o
  `relay:rpc.stream.pull` so podera ser emitido depois do primeiro chunk.
- Cancelamento e desconexao funcionam normalmente: o relay nao tem `rpc.cancel`; aborts vem por socket disconnect ou `sql.cancel` por `stream_id`.

Detalhes completos do contrato em [`docs/socket/socket_relay_protocol.md`](socket_relay_protocol.md) ("Relay unary fast-path").

### `requestServerTimings: boolean` — fases de latencia no envelope

Aplicavel a `relay:rpc.request`, ao Socket `agents:command` e ao REST `POST /api/v1/agents/commands`. Quando `true`, o hub anexa um snapshot de fases de latencia a resposta, permitindo correlacionar wall-clock fim-a-fim com tempo gasto internamente no hub e no agente.

**Onde aparece a resposta:**

- `relay:rpc.response` (PayloadFrame) → injetado no `meta.serverTimings` do JSON-RPC interno.
- `agents:command_response` (Socket) → campo top-level `serverTimings` no envelope.
- `POST /api/v1/agents/commands` (REST) → campo top-level `serverTimings` no corpo JSON da resposta.

```json
{
  "serverTimings": {
    "schemaVersion": 1,
    "phasesMs": {
      "consumer_frame_decode_ms": 0.42,
      "encode_ms": 0.85,
      "emit_to_socket_ms": 0.07,
      "agent_to_hub_ms": 142.1,
      "inbound_decode_ms": 0.41,
      "pending_resolve_ms": 0.18,
      "relay_forward_to_consumer_ms": 0.06
    }
  }
}
```

Regras:

- Todos os valores em **milissegundos**, arredondados a 3 casas. Esperado ~120 bytes por resposta.
- Chaves de `phasesMs` sao estaveis mas o conjunto pode crescer em versoes minor; consumers **devem tolerar chaves desconhecidas**.
- `schemaVersion` bumpea apenas em remocoes/renames/mudancas de unidade. Bump = major break — consumers devem degradar (ignorar `phasesMs`) na presenca de uma versao nao compreendida.
- A persistencia em DB continua respeitando `BRIDGE_LATENCY_TRACE_SAMPLE_PERCENT`. O flag forca a criacao da sessao para o envelope, mas nao infla persistencia.

Para consumers que combinem ambos os flags:

```json
{
  "conversationId": "<conv-id>",
  "frame": "<PayloadFrame>",
  "fastPath": true,
  "requestServerTimings": true
}
```

Esta combinacao corta o hop do `accepted` **e** permite medir o ganho com a mesma granularidade que o REST baseline.

Metricas Prometheus relacionadas:

- `plug_socket_relay_fast_path_requested_total` / `plug_socket_relay_fast_path_honored_total` / `plug_socket_relay_fast_path_fallback_dedup_total` / `plug_socket_relay_fast_path_fallback_error_total` / `plug_socket_relay_fast_path_stream_inadvertent_total`
- `plug_socket_relay_server_timings_opt_in_total` / `plug_socket_agents_command_server_timings_opt_in_total` / `plug_rest_agents_command_server_timings_opt_in_total`

## Escolha de canal

Use REST para bootstrap/auth/catalogo/CRUD/admin e Socket para comandos e tempo
real. `agents:command` e o caminho compativel com o bridge REST; `relay:*` e o
caminho recomendado para carga alta, streaming, idempotencia e backpressure.

| Necessidade                                                                                                  | Melhor canal                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Mesmo contrato do REST, incluindo batch, notification, `timeoutMs`, `pagination` e `payloadFrameCompression` | `agents:command`                                                                                                                   |
| Streaming em tempo real com controle de creditos                                                             | `relay:*`                                                                                                                          |
| Retry idempotente pelo cliente                                                                               | `relay:*`                                                                                                                          |
| Consulta SQL grande, relatorio ou payload alto                                                               | `relay:*` com `prefer_db_streaming`                                                                                                |
| `sql.bulkInsert` ou batch read-only sob carga                                                                | `agents:command` ou `relay:*`; quebrar imports acima de `AGENT_SQL_BULK_INSERT_MAX_ROWS` ou `AGENT_SQL_BULK_INSERT_MAX_JSON_BYTES` |
| Comandos simples sem estado de conversa                                                                      | REST ou `agents:command`                                                                                                           |
| Bootstrap, auth, catalogo, admin, health HTTP, metricas                                                      | REST                                                                                                                               |
| Fan-out cross-agent unary com baixa latencia                                                                 | `relay:*` com `fastPath: true` (ver "Opt-ins de performance" abaixo)                                                               |
| Medicao A/B REST vs Socket por fase                                                                          | qualquer canal com `requestServerTimings: true`                                                                                    |

Helper de referencia para clientes TypeScript: [`docs/snippets/agent_command_performance_options.ts`](snippets/agent_command_performance_options.ts).

### Resposta de `relay:rpc.stream.pull`

O servidor responde em JSON e inclui o orçamento restante da janela quando o pull é aceite ou rejeitado:

```json
{
  "success": true,
  "conversationId": "conv-1",
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

Em overload do namespace `/consumers`, ou quando a janela de créditos estoura, a resposta vem com `success: false`; no caso de rate-limit por créditos, `error.code = "RATE_LIMITED"` e o bloco `rateLimit` mostra o saldo remanescente.

### Resposta de `agents:stream_pull`

O servidor responde em **`agents:stream_pull_response`**, entregue como **`PayloadFrame`**
por defeito (hot-path encode, tipicamente `cmp: "none"`). Decodifique antes de ler
`success`, `streamId` ou `rateLimit` — ver _Migração PayloadFrame no bridge legado_.

Payload logico apos decode (pode incluir `rateLimit` quando o limiter por creditos
legacy `SOCKET_AGENTS_STREAM_PULL_RATE_LIMIT_MAX_CREDITS` estiver ativo ou quando
houver rejeicao):

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

## Observacoes importantes

- O `id` JSON-RPC do cliente vira `client_request_id` para idempotencia.
- O servidor gera `requestId` interno e devolve em `relay:rpc.accepted`.
- O hub encaminha ao agente apenas os campos `meta` publicados pelo schema do
  `plug_agente`; campos de compatibilidade aceitos na entrada (por exemplo
  `outbound_compression`) sao stripados antes do `rpc:request`.
- Em throughput alto, respeite backpressure com `relay:rpc.stream.pull`.
- O servidor aplica rate-limit por consumer em:
  - `relay:conversation.start`
  - `relay:rpc.request`
- `agents:command` e `agents:stream_pull` partilham o mesmo budget por janela no `/consumers`; o hub so consome esse budget depois da validacao estrutural e do inflight gate por socket. Em `agents:stream_pull`, `404` (stream inexistente/expirado) e falhas `5xx`/inesperadas **devolvem** esse budget partilhado; `401`/`403` e `429` de credito de pull **mantem**.
- Sob shed de overload da fila outbound relay, `agents:command` tambem recebe `SERVICE_UNAVAILABLE` (mesmo padrao dos eventos relay / `agents:stream_pull`).

## Desconexoes forçadas pelo servidor

Sessões `/consumers` podem ser encerradas ativamente com `app:error` antes do
disconnect:

- `ACCOUNT_BLOCKED`: `User` ou `Client` foi bloqueado apos o socket conectar
- `AGENT_ACCESS_REVOKED`: o acesso `Client -> Agent` foi revogado pelo owner ou pelo proprio client
- `CONSUMER_IDLE_TIMEOUT`: inactividade alem de `SOCKET_CONSUMER_IDLE_TIMEOUT_MS`
- `CONSUMER_SOCKET_INITIALIZATION_FAILED`: falha ao entrar nas rooms de identidade no connect
- Conta bloqueada detectada em `socket:event.*` (mesmo sinal `ACCOUNT_BLOCKED` / auth terminal)

Nota: `user`/`admin` que emitam `socket:event.*` recebem apenas `403` no ack —
**nao** forcam disconnect da sessao.

Recomendacao do SDK:

1. tratar `app:error` como sinal para invalidar cache local do socket
2. nao tentar reusar a mesma conexao apos `io server disconnect`
3. reautenticar / refazer bootstrap REST antes de abrir novo `/consumers`

## Push de perfil do agente

`client:agent.profile.updated` so e enviado para clients **ativos** e com acesso
efetivo no momento do fan-out. O hub ainda faz coalescing de bursts por `agentId`,
entao uma rajada de updates pode chegar como um unico push com a versao mais nova.

## Bridge de comandos (`agents:command` no `/consumers`)

Fora do relay, o mesmo namespace `/consumers` expoe **`agents:command`**, que encaminha JSON-RPC ao
agente via hub (PayloadFrame em `rpc:request` no `/agents`), com o mesmo caso de uso que
`POST /api/v1/agents/commands`.

**Paridade com o body REST (`AgentCommandRequest` / OpenAPI):** o payload validado e o mesmo
`agentCommandBodySchema`: `agentId`, `command` (objeto unico **ou** batch ate 32 itens), opcionais
`timeoutMs`, `pagination` (so `sql.execute` unico), `payloadFrameCompression` (`default` \| `none` \| `always`).
Tetos UTF-8 no JSON logico (`sql`, `params`, etc.) sao os **mesmos** que no REST; ver `docs/api/api_rest_bridge.md`
e descricoes em `swagger.ts`.

**Rate limit:** o `POST /api/v1/agents/commands` aplica limites por JWT `sub` (e opcionalmente por IP).
O evento **`agents:command`** usa os **mesmos** `REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS` e
`REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` por utilizador (`sub`); o contador e **independente** do HTTP (na
mesma janela podes consumir ate N por REST e ate N por Socket). Sockets sem `sub` usam chave por ligacao.
Metricas: `plug_socket_agents_command_rate_limit_*` em `/metrics`. O modo **relay** mantem quotas proprias
(`SOCKET_RELAY_RATE_LIMIT_*`).

### Migração PayloadFrame no bridge legado (`agents:*`)

**Resumo (2026):** outbound de `agents:command_response`, `agents:command_stream_chunk`,
`agents:command_stream_complete` e `agents:stream_pull_response` passou a **`PayloadFrame`**
por defeito no namespace `/consumers`. Antes, esses eventos chegavam em plain JSON.
Inbound de `agents:command` e `agents:stream_pull` continua a aceitar **plain JSON e
PayloadFrame** durante a janela de transicao (util para clientes que ja codificam o pedido
em frame binario). Contrato normativo em `src/shared/constants/agent_bridge_parity.ts`
(`agentsCommandWireMigration`, `agentsStreamPullWireMigration`).

**Eventos outbound que o cliente deve decodificar:**

| Evento                           | Payload logico apos decode                                                  |
| -------------------------------- | --------------------------------------------------------------------------- |
| `agents:command_response`        | `{ success, requestId?, response?, error?, streamId?, retryAfterSeconds? }` |
| `agents:command_stream_chunk`    | chunk JSON-RPC / linhas SQL do stream                                       |
| `agents:command_stream_complete` | `{ streamId, terminal_status?, error_code?, ... }`                          |
| `agents:stream_pull_response`    | `{ success, requestId?, streamId?, windowSize?, rateLimit?, error? }`       |

Respostas e stream chunks usam hot-path encode (`encodePayloadFrameHotPath`): tipicamente
`cmp: "none"` e sem `traceId` no envelope; correlacionar com `requestId` do frame ou do
JSON logico. `agents:command_response` pode usar gzip quando o body e grande (via
`encodePayloadFrame` + `payloadFrameCompression` do pedido).

**Helper de decode (transicao):** trate envelope `PayloadFrame` e plain JSON legado ate todos
os ambientes migrarem:

```ts
const isPayloadFrame = (raw: unknown): raw is PayloadFrame =>
  typeof raw === "object" &&
  raw !== null &&
  (raw as PayloadFrame).schemaVersion === "1.0" &&
  "payload" in raw;

const decodeAgentsWirePayload = <T>(raw: unknown): T =>
  isPayloadFrame(raw) ? decodeFrame(raw) : (raw as T);

socket.on("agents:command_response", (raw) => {
  const body = decodeAgentsWirePayload<AgentsCommandResponsePayload>(raw);
  if (!body.success) {
    console.error(body.error);
    return;
  }
  console.log(body.requestId, body.response);
});

socket.on("agents:command_stream_chunk", (raw) => {
  const chunk = decodeAgentsWirePayload<Record<string, unknown>>(raw);
  // processar chunk
});

socket.on("agents:command_stream_complete", (raw) => {
  const complete = decodeAgentsWirePayload<Record<string, unknown>>(raw);
  // encerrar stream local
});

socket.on("agents:stream_pull_response", (raw) => {
  const pull = decodeAgentsWirePayload<AgentsStreamPullResponsePayload>(raw);
  if (!pull.success) throw new Error(pull.error.message);
  console.log(pull.windowSize, pull.rateLimit?.remainingCredits);
});
```

`decodeFrame` e o tipo `PayloadFrame`: secao _Estrutura do PayloadFrame_ / snippet
[`docs/snippets/payload_frame_client_encode.ts`](snippets/payload_frame_client_encode.ts).
No servidor, helpers espelhados em `agents_command_wire.ts` e `agents_stream_pull_wire.ts`.

**Shims de compatibilidade (remocao prevista `2026-09-30`):**

| Variavel                                | Eventos afetados (outbound)                          | Defeito         | `raw_json`                 |
| --------------------------------------- | ---------------------------------------------------- | --------------- | -------------------------- |
| `SOCKET_CONNECTION_READY_COMPAT_MODE`   | `connection:ready`                                   | `payload_frame` | Restaura plain JSON legado |
| `SOCKET_AGENTS_COMMAND_COMPAT_MODE`     | `agents:command_response`, `agents:command_stream_*` | `payload_frame` | Restaura plain JSON legado |
| `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE` | `agents:stream_pull_response`                        | `payload_frame` | Restaura plain JSON legado |

Os shims controlam **apenas outbound**; inbound continua dual-format durante a transicao.
`SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE` e **independente** de `SOCKET_AGENTS_COMMAND_COMPAT_MODE`
para migrar command e stream*pull em calendarios diferentes. Apos `2026-09-30`, o arranque
regista `WARN` se `raw_json` ainda estiver activo (`warnIf*LegacyCompatExpired`). Detalhes
operacionais: `docs/configuration.md` (secções *PayloadFrame*, `SOCKET_AGENTS_COMMAND_COMPAT_MODE`,
`SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE`). Para observar disconnects por idle e rate limits durante
rollout: `docs/observability/observability.md` (`plug_consumer_idle_timeout_disconnect_total`,
`plug_socket_agents_command_rate_limit*\*`).

**Migracao recomendada para novos clientes:** decodificar `PayloadFrame` em todos os
eventos da tabela acima (incluindo `connection:ready`); enviar inbound plain JSON ou
PayloadFrame; evitar depender de `raw_json` em producao. Alternativa de longo prazo:
migrar para `relay:*` (PayloadFrame end-to-end, backpressure e idempotencia mais fortes).

Semantica do campo JSON-RPC **`id`** (alinhada ao REST):

| `id` no payload              | Comportamento                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **omitido**                  | O servidor gera **UUID** e aguarda resposta; `agents:command_response` traz o resultado normalizado (como HTTP 200).                                                                 |
| **`null`**                   | **Notification**: sem pending; resposta de aceitacao com tipo notification (como HTTP 202).                                                                                          |
| **string / number**          | Correlacao explicita; repassado ao agente.                                                                                                                                           |
| **string / number repetido** | Dentro da janela process-local de 2 min por `agentId + tipo + valor`, o hub responde `response.item.error.code = -32014`, `reason = "replay_detected"`, sem novo dispatch ao agente. |

**Diferenca em relacao ao plug_agente direto:** no socket direto ao agente, omitir `id` costuma ser
notification; no **hub plug_server** a omissao e preenchida para facilitar integracao. Detalhes:
`docs/api/api_rest_bridge.md` (secao _Hub vs agente direto_).

`idempotency_key` e uma deduplicacao de negocio/execucao onde o metodo suporta
isso; ela nao substitui `command.id`, que segue sendo a correlacao JSON-RPC e a
chave usada pelo guard de replay do bridge.

### Exemplo de body JSON (`agents:command`)

Espelha o mesmo objeto que enviarias no body do `POST /api/v1/agents/commands` (ver OpenAPI em
`agents.routes.ts` / Swagger). Resposta em `agents:command_response` (**PayloadFrame** por
defeito — decodificar antes de ler `success`/`response`) e chunks em
`agents:command_stream_chunk` / `agents:command_stream_complete` se houver stream (tambem
PayloadFrame). Backpressure: `agents:stream_pull` → `agents:stream_pull_response` (PayloadFrame).

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "timeoutMs": 15000,
  "payloadFrameCompression": "default",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-socket-1",
    "api_version": "2.11.2",
    "meta": {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
    },
    "params": {
      "sql": "SELECT 1",
      "client_token": "token-value",
      "options": {
        "execution_mode": "preserve"
      }
    }
  }
}
```

Batch: o campo `command` pode ser um **array** de ate 32 pedidos JSON-RPC (mesmas regras que o REST).
Paginacao no nivel do body: `pagination: { "page": 1, "pageSize": 100 }` apenas com `sql.execute` unico.
