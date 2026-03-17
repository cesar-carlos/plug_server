# Socket Relay Protocol (N:1)

Data: 2026-03-17

## Objetivo

Canal Socket em modo relay/chat-like para permitir varias conversas simultaneas
entre consumers e o mesmo agente, sem alterar o canal REST.

Fluxo:

`consumer -> plug_server -> agente`

## Namespaces

- `/consumers`: controle de conversa e envio de frames relay
- `/agents`: protocolo padrao do agente (`rpc:*` em `PayloadFrame`)

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
- `relay:rpc.stream.pull_response` -> status do pull (`requestId`, `streamId`, `windowSize`) ou erro

## Payload

No relay, o consumer envia `PayloadFrame` em:

- `relay:rpc.request` (campo `frame`)
- `relay:rpc.stream.pull` (campo `frame`)

O servidor encaminha para o agente como `rpc:*` e reenvelopa respostas/chunks em
`PayloadFrame` para o consumer.

### PayloadFrame (binario/compressao/assinatura)

Campos relevantes do frame:

- `schemaVersion` (`1.0`)
- `enc` (`json`)
- `cmp` (`none` ou `gzip`)
- `contentType` (`application/json`)
- `originalSize` / `compressedSize`
- `payload` (binario: `Buffer`, `Uint8Array` ou array de bytes)
- `traceId` e `requestId` (quando aplicavel)
- `signature` opcional (`hmac-sha256`)

Regras atuais no servidor:

- compressao de saida automatica acima de `1024` bytes
- limite de payload comprimido: `10 MB`
- limite de payload decodificado: `10 MB`
- limite de inflacao gzip: `20x`
- se `signature` vier no frame, o servidor valida com `PAYLOAD_SIGNING_KEY`
  (quando nao configurada e houver assinatura, a validacao falha)

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
  de memoria para evitar explosao de uso.
- Quotas de protecao: limites para conversas, pending requests por conversa e
  por consumer.
- Limpeza por inatividade: conversas inativas expiram automaticamente por TTL.
- Metricas em memoria: o servidor registra contadores de throughput, timeout,
  dedupe e perdas por backpressure.

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
REST nao foi alterado.

## SDK cliente

Exemplo minimo de cliente relay:

- `docs/socket_client_sdk.md`
