# Socket Relay Protocol (N:1)

Data: 2026-03-20

## Objetivo

Canal Socket em modo relay/chat-like para permitir varias conversas simultaneas
entre consumers e o mesmo agente, sem alterar o canal REST.

Fluxo:

`consumer -> plug_server -> agente`

## Namespaces

- `/consumers`: controle de conversa e envio de frames relay
- `/agents`: protocolo padrao do agente (`rpc:*` em `PayloadFrame`)

## Handshake: `connection:ready`

Emitido imediatamente após autenticação bem-sucedida. **Desde versão mais recente, enviado como `PayloadFrame`** para consistência com outros eventos RPC.

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

## Eventos de controle (JSON)

Eventos abaixo usam payload JSON logico (nao `PayloadFrame`):

- `relay:conversation.start` -> `{ agentId }`
- `relay:conversation.started` -> `{ success, conversationId, agentId, createdAt }` ou erro
- `relay:conversation.end` -> `{ conversationId }`
- `relay:conversation.ended` -> `{ success, conversationId, reason }` ou erro
- `relay:rpc.accepted` -> status de aceite/dedupe (`requestId`, `clientRequestId`, `deduplicated`, `replayed`)
- `relay:rpc.stream.pull_response` -> status do pull (`requestId`, `streamId`, `windowSize`, `rateLimit`) ou erro

## Contrato RPC e metodos suportados

O consumer deve enviar payloads que sigam o contrato do plug_agente. Referencia:
`plug_agente/docs/communication/socket_communication_standard.md`.

**Metodos suportados:** `sql.execute`, `sql.executeBatch`, `sql.cancel`, `rpc.discover`.

**Opcoes relevantes em `sql.execute`:** `execution_mode` (`managed` | `preserve`),
`preserve_sql` (alias legado), `page`, `page_size`, `cursor`, `multi_result`, etc.

O servidor valida o payload com o schema do bridge (`bridgeCommandSchema`, o mesmo nucleo que REST) antes de encaminhar, incluindo **tetos UTF-8** do JSON logico (`sql` ate 1 MiB, `params` nomeado serializado ate 2 MiB, `rpc.discover` `params` ate 64 KiB — ver `docs/api_rest_bridge.md`). Payloads
invalidos retornam erro `VALIDATION_ERROR` em `relay:rpc.accepted`. O relay **nao**
suporta batch JSON-RPC (array); envie um unico request por `relay:rpc.request`.

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
- limite de payload comprimido: `10 MB`
- limite de payload decodificado: `10 MB`
- limite de inflacao gzip: `20x`
- se `signature` vier no frame, o servidor valida com `PAYLOAD_SIGNING_KEY`
  (quando nao configurada e houver assinatura, a validacao falha)
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
  conversa sao deduplicadas por TTL.
- Timeout de relay request: quando o agente nao responde no prazo, o servidor
  devolve erro JSON-RPC no `relay:rpc.response`.
- Circuit breaker por agente: falhas consecutivas abrem circuito por janela
  curta, bloqueando novas requests temporariamente.
- Backpressure reforcado: chunks no relay respeitam creditos de
  `relay:rpc.stream.pull`.
- Buffer com limites: chunks sao bufferizados por request e globalmente com cap
  de memoria para evitar explosao de uso; se o agente exceder esse buffer, o hub
  fecha o stream com `relay:rpc.complete` terminal (`terminal_status: "aborted"`)
  em vez de descartar chunks silenciosamente.
- Pull capability-aware: quando o agente anuncia janela recomendada/maxima
  (`recommendedStreamPullWindowSize` / `maxStreamPullWindowSize`, em `extensions`
  ou `limits`), o hub aplica esse clamp tanto no pull interno quanto nas requests
  do consumer.
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
- `SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD`
- `SOCKET_RELAY_CIRCUIT_OPEN_MS`
- `SOCKET_RELAY_METRICS_LOG_INTERVAL_MS`
- `SOCKET_RELAY_RATE_LIMIT_WINDOW_MS`
- `SOCKET_RELAY_RATE_LIMIT_MAX_CONVERSATION_STARTS`
- `SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS`

### Rate limit por consumer (janela fixa)

Os limites `SOCKET_RELAY_RATE_LIMIT_*` aplicam-se por identidade lógica (`relay:user:<sub>` quando autenticado; `relay:anon:<socketId>` como fallback) e usam **janela fixa**: quando decorre `SOCKET_RELAY_RATE_LIMIT_WINDOW_MS` desde o inicio da janela, os contadores de `relay:conversation.start`, `relay:rpc.request` e do orçamento de créditos de `relay:rpc.stream.pull` **zeram** de uma vez. Nao e *sliding window*; o trafego pode concentrar-se nos limites de cada janela. Estados inativos sao removidos pelo sweep periodico (`SOCKET_RELAY_RATE_LIMIT_SWEEP_STALE_MULTIPLIER` x duracao da janela) e ao disconnect apenas para chaves anónimas.

Métricas Prometheus em `GET /metrics`: `plug_socket_relay_rate_limit_conversation_start_allowed_total`, `..._rejected_total`, `plug_socket_relay_rate_limit_request_allowed_total`, `..._rejected_total`, etc.

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
(*Dois canais para comandos ao agente*).

## SDK cliente

Exemplo minimo de cliente relay:

- `docs/socket_client_sdk.md`
