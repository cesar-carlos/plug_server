# Configuracao

## Fonte de verdade para defaults

- **Variaveis**: valores por defeito e parsing em [`src/shared/config/env.ts`](../src/shared/config/env.ts) (Zod `.default()` / `preprocess`).
- **Exemplo local**: [`.env.example`](../.env.example) (copiar para `.env`).
- **Documentacao narrativa**: `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md`, `docs/performance_hub_agent.md`, `docs/user_status.md` (estados de utilizador e bloqueio).
- **Mapa da documentacao**: `docs/README.md`.

Evite duplicar numeros em varios sitios sem atualizar `env.ts`; quando duvidar, confira o ficheiro de env ou `.env.example`.

### `HUB_INSTANCE_ID` (opcional)

| Variável          | Defeito   | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_INSTANCE_ID` | _(vazio)_ | Quando definida (string não vazia), o middleware global `hubInstanceIdMiddleware` adiciona o header HTTP `X-Hub-Instance-Id` com este valor a **toda resposta Express** (REST sob `/api/v1`, `/auth`, Swagger, `/metrics`, 404). Permite ao cliente validar afinidade de sessão (sticky) em qualquer endpoint, e correlacionar logs/métricas com a réplica que processou cada request. O campo JSON `isHubConnected` continua a ser por processo. Receitas de sticky session em `docs/nginx_production.md` § 12. |

### `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED` (opcional)

| Variável                                   | Defeito | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED` | `true`  | Gateia o registro do handler de broadcast `client:agent.profile.updated` no namespace `/consumers`. Default mantém o comportamento sempre-ativo (clientes aprovados recebem push em mudanças do catálogo do agente). Setar `false` é um kill-switch operacional: o resto do `/consumers` (relay, consultas, agents:command) segue funcionando, e os clientes caem em modo polling para ler `profileVersion`. Mudança requer restart (Zod parseia `process.env` no boot). |

### `SOCKET_CONSUMER_ROLES` (opcional)

| Variável                | Defeito             | Notas                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_CONSUMER_ROLES` | `user,admin,client` | Lista separada por vírgulas de `role` JWT permitidas no handshake do namespace Socket.IO **`/consumers`**. O literal **`client`** é necessário para apps Colmeia (principal `Client`). Se a variável listar só `user,admin`, o processo **acrescenta** `client` no parse (ver `parseSocketConsumerRolesValue` em `env.ts`) e regista `INFO` `socket_consumer_roles_ensured_client` no arranque. |

### `SOCKET_AUTH_REQUIRED` (opcional)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_AUTH_REQUIRED` | `true` | Quando `false`, o middleware do namespace **`/agents`** pode aceitar ligacao **sem** token no handshake (modo desenvolvimento / compat). Em **produção** mantém `true`. O namespace **`/consumers`** continua a exigir JWT válido no handshake independentemente desta flag (ver `docs/socket_client_sdk.md`). |

### Checklist produção (smoke socket / Colmeia)

1. **`SOCKET_CONSUMER_ROLES`**: no PID, confirmar o valor; se faltar o literal `client` na string, o runtime acrescenta (ver tabela acima) e o efeito final inclui `client`.
2. **`SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED`**: `true` ou ausente; `false` desliga push de catálogo (polling no app).
3. **`POST /api/v1/agents/commands`** com agente offline mas **já** registado nesse worker: resposta **200** com `response.item.error.code === -32000` e `data.reason === agent_disconnected_at_dispatch` quando o JSON-RPC tem `id` correlacionável (ver tabela _Erros HTTP_ em `docs/api_rest_bridge.md`).
4. **Multi-réplica**: `HUB_INSTANCE_ID` + header `X-Hub-Instance-Id` estável entre pedidos do mesmo cliente; sticky no nginx — `docs/nginx_production.md` § 12.

### `NODE_ENV=production` sem variável definida

Se a variável **não** estiver no ambiente, alguns defaults diferem em produção (desempenho):

| Comportamento                             | Produção (unset) | Não produção (unset)     |
| ----------------------------------------- | ---------------- | ------------------------ |
| `SOCKET_IO_TRANSPORTS`                    | `websocket`      | `websocket,polling`      |
| `SOCKET_IO_HTTP_COMPRESSION`              | `false`          | `true`                   |
| `PAYLOAD_FRAME_GZIP_LEVEL`                | `3`              | _(default zlib Node ~6)_ |
| `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT` | `25`             | `100`                    |

Definir explicitamente a variável no `.env` / plataforma ignora estes ramos.

## PayloadFrame (hub → agente)

| Variável                                          | Defeito                                          | Notas                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES`              | `524288` (512 KiB)                               | Só tenta gzip quando o JSON UTF-8 não excede este tamanho; ver `docs/performance_hub_agent.md`.                                                                                                                                                                                                                                                                                                  |
| `PAYLOAD_FRAME_GZIP_LEVEL`                        | ver tabela _production_ acima; senão _(omitido)_ | Nível zlib `1`–`9` para gzip do hub; fora do ramo produção omitir = default Node (~6).                                                                                                                                                                                                                                                                                                           |
| `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES`         | `131072` (128 KiB)                               | Hub→agente (`encodePayloadFrameBridge`): JSON elegível para gzip com pelo menos este tamanho usa **gzip assíncrono**. `0` = sempre síncrono.                                                                                                                                                                                                                                                     |
| `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` | `65536` (64 KiB)                                 | Hub **inbound** (`decodePayloadFrameAsync`): `cmp: gzip` com payload comprimido ≥ este tamanho usa **gunzip assíncrono**. `0` = sempre síncrono.                                                                                                                                                                                                                                                 |
| `SOCKET_AGENT_KNOWN_IDS_MAX`                      | `0`                                              | Teto do conjunto de `agentId` “conhecidos” (offline) para REST; acima disto remove-se IDs **desligados** até ficar abaixo do limite. `0` = sem limite.                                                                                                                                                                                                                                           |
| `SOCKET_AGENT_PROTOCOL_READY_GRACE_MS`            | `100`                                            | Fallback de estabilização após `agent:register` antes do primeiro `rpc:request`; o hub libera mais cedo com `agent:heartbeat` e também suporta `agent:ready` explícito quando o agente anuncia `extensions.protocolReadyAck`. Reduz corrida com `protocol_not_ready` do `plug_agente`.                                                                                                           |
| `SOCKET_AGENT_SESSION_POLICY`                     | `reject_active`                                   | `reject_active`: recusa um segundo `agent:register` enquanto outro socket canonico do mesmo `agentId` estiver ligado neste processo. `takeover_disconnect_previous`: substitui e desliga o socket anterior (emite `agent:session.superseded` antes do disconnect). `legacy_silent_takeover`: comportamento antigo (substitui registo sem forcar disconnect). |
| `SOCKET_AGENT_REGISTER_RATE_LIMIT_WINDOW_MS`      | `0`                                               | Janela (ms) para limitar tentativas de `agent:register` por par `(userId, agentId)`. `0` desativa. Corre **antes** do bind na BD para cortar rajadas sem stress na base.                                                                                                                                                                                                                                                                                     |
| `SOCKET_AGENT_REGISTER_RATE_LIMIT_MAX`            | `0`                                               | Maximo de `agent:register` permitidos por janela por `(userId, agentId)`. `0` desativa.                                                                                                                                                                                                                                                                                                      |
| `AGENT_REGISTER_BIND_CACHE_TTL_MS`                | `5000`                                            | Apos `assertOwnershipEligible`, positivos podem omitir `ensureCatalogAgentExistsForIdentity` + `bindIfUnbound` ate expirar (rajadas de reconnect). `0` desliga. Invalidacao com os mesmos hooks que `invalidateAccessCache*` / `AGENT_ACCESS_CACHE_*`.                                                                                                                                                                                                        |
| `AGENT_REGISTER_BIND_CACHE_MAX_SIZE`              | `2000`                                            | Tamanho maximo do cache em memoria do bind-register; `0` = sem limite de entradas (TTL continua a aplicar-se por entrada).                                                                                                                                                                                                                                                                   |
| `SOCKET_AGENT_PROFILE_SYNC_MAX_CONCURRENT`        | `8`                                              | Máximo de syncs `agent.getProfile` em paralelo após `agent:register` (reduz rajada quando muitos agentes reconectam).                                                                                                                                                                                                                                           |
| `PAYLOAD_SIGN_OUTBOUND`                           | `false`                                          | Assina frames de saída com `PAYLOAD_SIGNING_KEY` (HMAC-SHA256 sobre JSON canônico do `PayloadFrame` sem `signature`, com `payload` em base64 e chaves ordenadas).                                                                                                                                                                                                                              |
| `PAYLOAD_SIGNING_KEY`                             | _(vazio)_                                        | Chave compartilhada para assinar/verificar `PayloadFrame.signature`. Quando ausente e um frame chega assinado, a verificação **falha**.                                                                                                                                                                                                                                                          |
| `PAYLOAD_SIGNING_KEY_ID`                          | _(vazio)_                                        | Identificador da chave (ex.: `hub-2026-q2`). Quando definida, frames recebidos **devem** trazer `signature.key_id` igual ao configurado — ausente ou divergente → `-32001` (`invalid_signature`). Sem essa env, o hub aceita assinaturas sem `key_id` (modo single-key, mais permissivo que o `payload-frame.schema.json` do agente). Use sempre que houver rotação ou múltiplas chaves activas. |

## Client thumbnail e password recovery

| Variável                                             | Defeito                   | Notas                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPLOADS_DIR`                                        | `uploads`                 | Diretório base para arquivos locais servidos em `/uploads`. Em produção, usar volume persistente.                                                                                                                 |
| `UPLOADS_PUBLIC_BASE_URL`                            | `APP_BASE_URL + /uploads` | Prefixo público das URLs de thumbnail.                                                                                                                                                                            |
| `CLIENT_THUMBNAIL_MAX_BYTES`                         | `2097152`                 | Limite do upload da thumbnail (max **10 MiB** em `env.ts`); `client_max_body_size` no Nginx deve ser >= este valor — ver exemplo **11m** em `docs/nginx_production.md` e `deploy/nginx/plug_server.conf.example`. |
| `CLIENT_THUMBNAIL_WIDTH`                             | `256`                     | Largura final da thumbnail após normalização.                                                                                                                                                                     |
| `CLIENT_THUMBNAIL_HEIGHT`                            | `256`                     | Altura final da thumbnail após normalização.                                                                                                                                                                      |
| `CLIENT_THUMBNAIL_WEBP_QUALITY`                      | `82`                      | Qualidade da conversão para `webp`.                                                                                                                                                                               |
| `CLIENT_PASSWORD_RECOVERY_TOKEN_EXPIRES_IN`          | `30m`                     | Expiração do token de recuperação de senha do client.                                                                                                                                                             |
| `REST_CLIENT_THUMBNAIL_RATE_LIMIT_WINDOW_MS`         | `60000`                   | Janela do rate limit para upload de thumbnail.                                                                                                                                                                    |
| `REST_CLIENT_THUMBNAIL_RATE_LIMIT_MAX`               | `20`                      | Máximo de uploads de thumbnail por janela.                                                                                                                                                                        |
| `REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_WINDOW_MS` | `300000`                  | Janela do rate limit para request de recuperação de senha.                                                                                                                                                        |
| `REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_MAX`       | `10`                      | Máximo de requests de recuperação por janela.                                                                                                                                                                     |

## REST bridge e auditoria (env)

| Variável                                        | Defeito                              | Notas                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`           | `256`                                | Janela interna ao materializar `sql.execute` em stream no REST (menos round-trips com valores maiores).                                                                                                             |
| `SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE`       | `256`                                | Limite máximo anunciado em `agent:capabilities.extensions.maxStreamPullWindowSize`; permite separar a recomendação operacional do teto aceito pelo hub. O valor recomendado publicado nunca ultrapassa este máximo. |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_BYTES`  | `268435456`                          | Teto agregado de bytes UTF-8 materializados no REST (resposta inicial + chunks). Complementa o limite por linhas para proteger contra payloads JSONB muito largos.                                                  |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_CHUNKS` | `100000`                             | Teto de `rpc:chunk` aceites na materialização REST. `0` continua a significar ilimitado, mas deixou de ser o default.                                                                                               |
| `SOCKET_AUDIT_BATCH_MAX`                        | `48`                                 | Eventos por transação na auditoria Socket (1 = um INSERT por evento).                                                                                                                                               |
| `SOCKET_AUDIT_BATCH_FLUSH_MS`                   | `200`                                | Intervalo máximo antes de flush do lote de auditoria.                                                                                                                                                               |
| `SOCKET_AUDIT_MAX_QUEUE`                        | `50000`                              | Cap de eventos em memória antes de começar a descartar os mais antigos. Evita crescimento sem limite quando a BD atrasa.                                                                                            |
| `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT`       | ver tabela _production_; senão `100` | Percentagem de eventos de auditoria em `relay:rpc.chunk` persistidos.                                                                                                                                               |

## Guards e limites do consumer socket

| Variável                                                | Defeito  | Notas                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS`                   | `0`      | Quando `> 0`, o guard de conta activa nos sockets (`assertJwtUserAccountActive`) pode **omitir** a query à BD no mesmo socket até expirar o TTL (útil em consumidores com muitos eventos). `block`/`unblock` pode atrasar-se até esse intervalo. `0` = sempre consultar a BD (comportamento por defeito). Métricas: `plug_socket_consumers_guard_db_*`. |
| `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`               | `32`     | Teto de operações assíncronas simultâneas por socket consumer (`agents:command`, `relay:rpc.request`, `agents:stream_pull`, `relay:rpc.stream.pull`). Quando `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` é `0`, `socket:event.publish` **partilha** este teto. |
| `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET`   | `0`      | Quando `> 0`, `socket:event.publish` usa um contador **próprio** (não conta para o teto acima), evitando que relay/comandos monopolizem publicações custom ou o inverso. `0` = publicação custom partilha `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`. Quando **ambos** `> 0`, os dois contadores são independentes: no pior caso o socket pode ter até **soma** dos dois valores de operações em voo (relay/comandos + publicações custom). |
| `SOCKET_RATE_LIMIT_REDIS_URL`                           | _(vazio)_ | Redis opcional para rate limits Socket (`agents:command`, `agents:stream_pull`, `relay:*`, `agent:register`). Vazio = memoria por processo. Quando configurado, falha de Redis e fail-open com fallback local; sticky sessions continuam obrigatorias para estado Socket. |
| `SOCKET_RELAY_AGENT_MAX_INFLIGHT`                       | `32`     | Requests `relay:rpc.request` simultaneas por agente antes de enfileirar. `0` desativa o gate por agente.                                                                                                                                                                                                                         |
| `SOCKET_RELAY_AGENT_MAX_QUEUE`                          | `64`     | Profundidade da fila FIFO por agente para relay. `0` = fila ilimitada (ainda sujeita a timeout).                                                                                                                                                                                                                                  |
| `SOCKET_RELAY_AGENT_QUEUE_WAIT_MS`                      | `200`    | Tempo maximo aguardando slot na fila por agente; rejeita com `SERVICE_UNAVAILABLE` e `retryAfterMs` quando estoura.                                                                                                                                                                                                               |
| `SOCKET_AGENTS_STREAM_PULL_RATE_LIMIT_MAX_CREDITS`      | `0`      | Orcamento por janela para creditos de `agents:stream_pull` legacy. `0` preserva comportamento anterior sem limite por creditos; quando ativo, a resposta inclui `rateLimit`.                                                                                                                                                      |
| `SOCKET_AGENTS_COMMAND_RATE_LIMIT_WEIGHTED_COSTS`       | `false`  | Quando `true`, `agents:command` consome creditos por trabalho aproximado (`command[]` soma itens; `sql.executeBatch` soma comandos internos). `false` preserva o comportamento historico de um evento = um credito.                                                                                                                   |
| `SOCKET_CUSTOM_EVENT_MAX_SUBSCRIPTIONS_PER_SOCKET`      | `128`    | Maximo de eventos `client:custom.*` que um socket `/consumers` pode assinar ao mesmo tempo. `0` = ilimitado.                                                                                                                                                                                                                       |
| `SOCKET_CUSTOM_EVENT_SUBSCRIPTION_RATE_LIMIT_WINDOW_MS` | `60000`  | Janela do rate limit local para controles `socket:event.subscribe` / `socket:event.unsubscribe` por socket.                                                                                                                                                                                                                       |
| `SOCKET_CUSTOM_EVENT_SUBSCRIPTION_RATE_LIMIT_MAX`       | `240`    | Quantidade maxima de subscribe/unsubscribe validos por socket dentro da janela. `0` desativa.                                                                                                                                                                                                                                      |
| `SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION` | `1024`   | Cap FIFO por conversa para o mapa de idempotência relay.                                                                                                                                                                                                                                                                         |
| `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES`            | `100000` | Cap FIFO global para o mapa de idempotência relay. `0` desativa o teto global.                                                                                                                                                                                                                                                   |

## REST -> Socket pub/sub customizado

| Variavel                                   | Defeito   | Notas                                                                                     |
| ------------------------------------------ | --------- | ----------------------------------------------------------------------------------------- |
| `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`   | `60000`   | Janela do rate limit de `POST /api/v1/client/me/socket-events` (por IP/JWT conforme middleware). |
| `REST_SOCKET_EVENT_RATE_LIMIT_MAX`         | `120`     | Publicacoes REST permitidas por janela. `0` desativa o limitador HTTP desta rota. Com `skipFailedRequests` + `requestWasSuccessful` (`statusCode < 500`), respostas **5xx** ao fim do pedido **decrementam** o hit (alinhado ao refund do rate limit de `socket:event.publish` em falhas transitorias); **4xx** (validacao, `409`, `413`, etc.) **mantem** o hit. |
| `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_WINDOW_MS` | _(espelha `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`)_ | Quando definida, janela (ms) **apenas** para `socket:event.publish` (balde independente do Express e do contador REST). |
| `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_MAX` | _(espelha `REST_SOCKET_EVENT_RATE_LIMIT_MAX`)_ | Quando definida, maximo de `socket:event.publish` por janela por JWT `sub` de `Client`. `0` desativa o limitador Socket deste evento. |
| `REST_SOCKET_EVENT_MAX_FILES`              | `5`       | Numero maximo de anexos multipart inline (`files`).                                       |
| `REST_SOCKET_EVENT_FILE_MAX_BYTES`         | `524288`  | Tamanho maximo por arquivo inline.                                                        |
| `REST_SOCKET_EVENT_TOTAL_FILES_MAX_BYTES`  | `2097152` | Soma maxima dos anexos inline por publicacao.                                             |
| `REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES` | `524288`  | Teto UTF-8 do `payload` JSON antes de empacotar em `PayloadFrame`.                        |
| `REST_SOCKET_EVENT_MAX_RECIPIENTS`         | `0`       | Teto opcional de fan-out local por publicacao. `0` = ilimitado; quando estoura, retorna `503`. Com `0`, cada publicacao faz `fetchSockets` na room para contar destinatarios (**custo O(n)** por publicacao em eventos muito subscritos); em cargas expostas defina um teto > 0. |
| `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` | `2000`   | Valor (ms) de `error.details.retry_after_ms` nesse `503` (REST e `socket:event.publish`); **não** é a janela do rate limit de publicação (`REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`). |
| `REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS`     | `300000`  | Janela em memoria para deduplicar publicacoes com `Idempotency-Key` (REST) ou `idempotencyKey` no corpo (`socket:event.publish`). **`0` desativa o armazenamento**: a chave ainda pode ser validada em formato, mas **nao** ha replay guardado (cada pedido emite de novo). Com TTL > 0, pedidos **concorrentes** com a mesma chave no **mesmo processo** sao serializados para evitar dupla emissao antes da escrita no cache. **Sequencial** (um apos o outro) com TTL `0`: o segundo pedido com a mesma chave **pode voltar a emitir** — use TTL > 0 para replay entre tentativas. |
| `REST_SOCKET_EVENT_IDEMPOTENCY_MAX_ENTRIES` | `10000`  | Maximo de respostas idempotentes retidas por processo. Quando o mapa enche, entradas sao expulsas pela **ordem de insercao** (primeira chave do `Map`) ate haver espaco — nao e eviction por `expiresAtMs` mais antigo; o prune por TTL continua a correr em escritas. |
| `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` | `0` | Maximo de cadeias de serializacao **distintas** `(clientId, idempotencyKey)` em voo no processo; `0` = ilimitado. Acima do teto, novas chaves distintas recebem `503` ate concluirem publicacoes em curso; `error.details.retry_after_ms` segue `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (como no `503` de fan-out). Nao coordena entre replicas. |

O hub tambem calcula `socketEventPublishRawJsonMaxBytes` (sem variavel de ambiente dedicada): e o teto em bytes UTF-8 para o JSON bruto de `socket:event.publish` antes do Zod, derivado de `REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES` e dos tetos de anexos REST. Deve ser **inferior ou igual** a `SOCKET_IO_MAX_HTTP_BUFFER_BYTES` (pacote Engine.IO); caso contrario o hub regista `WARN` no arranque — mensagens maiores que o buffer podem ser cortadas antes do handler.

**Redis (rate limits, chaves ilustrativas):**

| Canal | Prefixo / scope | Sufixo de identidade (Client JWT `sub`) |
| ----- | ----------------- | ---------------------------------------- |
| HTTP `POST .../socket-events` | `plug_rl:client_socket_event_publish:` (`express-rate-limit`) | `client:<sub>` (ou `client:anonymous` sem `sub`) |
| Socket `socket:event.publish` | `plug_socket_rl:client_socket_event_publish:` | `client:<sub>` |

Os dois sistemas sao independentes (prefixos diferentes); contadores REST e Socket nao se misturam.

O endpoint REST e `socket:event.publish` enviam para clientes
inscritos em `client:custom.*` via `socket:event.subscribe`. Em multi-replica
sem adapter distribuido do Socket.IO, a entrega alcanca somente sockets
conectados a mesma replica que processou o pedido (REST ou Socket).

## Client → Agent: bearer token armazenado por par

Tabela `client_agent_accesses` ganhou a coluna opcional
`client_token VARCHAR(512)` (migration
`20260418190000_client_agent_access_client_token`). É o token que o cliente
final usa em `sql.execute params.client_token` no agente; armazenamos por par
`(client, agent)` para que cada cliente possa ter um token diferente em cada
agente, ou nenhum token (`NULL`).

| Endpoint                                                                  | Comportamento                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/client/me/agents/{agentId}/client-token`                     | Retorna o token (ou `null`). 403 sem acesso aprovado.                                                        |
| `PUT /api/v1/client/me/agents/{agentId}/client-token`                     | Body `{ clientToken: string \| null }`. String vazia vira `null`. Tamanho ≤ 512. Não cria a linha de acesso. |
| `GET /api/v1/client/me/agents` e `GET /api/v1/client/me/agents/{agentId}` | Cada agente carrega `hasClientToken: boolean` (sem expor o valor).                                           |

Não há limite de rate específico para `PUT client-token` além do
`globalRateLimit` (`/api/v1` 300 req / 15 min) — pondere subir um limiter
dedicado se for usado em UI com edição contínua.

## REST: CORS, request id, rate limits

| Variável / Comportamento          | Defeito                               | Notas                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGIN`                     | `*` em dev; **rejeitado** em produção | Aceita uma origem única **ou** lista separada por vírgula (`https://a,https://b`). A mesma política parseada é reutilizada por **HTTP e Socket.IO**; quando há lista de origens específicas, ambos validam o `Origin` e habilitam credentials. `*` desativa credentials.                                      |
| `HTTP_TRUST_PROXY`                | `true` em produção                    | `1` hop. Necessário para `req.ip` e rate limits corretos atrás de Nginx ou outro reverse proxy.                                                                                                                                                                                                               |
| `DATABASE_URL`                    | _(obrigatório)_                       | URL Postgres (Prisma). Em carga alta, usar `connection_limit` e `pool_timeout` na query string conforme o plano da base e réplicas do hub (ex. `?connection_limit=10&pool_timeout=20`). Os emails em `users.email` e `clients.email` usam o tipo **`citext`** (unicidade insensível a maiúsculas); a migração `20260512190000_citext_user_client_email` cria a extensão `citext` — em Postgres gerido, ative-a no projeto antes de `prisma migrate deploy`. |
| Header `x-request-id`             | **sanitizado**                        | Aceito apenas se casar `^[A-Za-z0-9._-]{1,128}$`; caso contrário é substituído por `crypto.randomUUID()` para evitar log injection e header splitting. Sempre volta na resposta como `x-request-id`.                                                                                                          |
| `credentialAuthRateLimit`         | `25` requests / `15m`                 | Endpoints **com senha ou revogação sensível**: `/api/v1/auth/login`, `register`, `agent-login`, `logout`, `registration/*`, `/api/v1/client-auth/login`, `logout`, equivalentes e `/client-auth/password-recovery/reset`, `/client-access/{review,status,approve,reject}`. **Não** inclui `POST .../refresh`. |
| `REST_TOKEN_REFRESH_RATE_LIMIT_*` | `400` requests / `15m` (padrão)       | Aplicado só a `POST /auth/refresh` e `POST /client-auth/refresh` (e aliases `/api/v1/...`), para permitir rotação em massa de access tokens após quedas (muitos agentes no mesmo IP).                                                                                                                         |
| `REST_RATE_LIMIT_REDIS_URL` | _(vazio)_ | Opcional. URL Redis (`redis://host:6379`) para estado partilhado dos limitadores HTTP entre réplicas; vazio mantém store em memória por processo. Sem palavra-passe na URL = Redis sem `requirepass` (reforçar rede/firewall). Fail-open com circuito temporário em falha runtime. Métricas: `plug_rest_http_rate_limit_redis_*` em `/metrics`. |

**Checklist plug_agente / UI (reconexão):** refresh proativo do access JWT antes do `exp`; em falha de handshake `/agents` com 401, chamar `POST /auth/refresh` e reconectar; ao receber `app:error` com `code: SERVER_SHUTDOWN`, backoff com jitter antes de retentar; tratar `agent:register_error.reason` (`transient_failure` / `rate_limited` vs reconexão forçada) conforme [`agent_register_error.ts`](../src/presentation/socket/hub/agent_register_error.ts).

| Cookie `refresh_token` / `client_refresh_token` | `HttpOnly`, `Secure` em prod, `SameSite=Strict`, `Path=/`, `Max-Age` = `JWT_REFRESH_EXPIRES_IN` correspondente | `Max-Age` usa o mesmo env do JWT para evitar cookie órfão após revogação. Logout sempre limpa o cookie; change-password de `User` e `Client` também limpa para refletir invalidação de sessão. |
| `/metrics` (root e `/api/v1/metrics`) | exige `requireAuthAndActiveAccount` + role `admin` | Restrito a admin. Use `HUB_INSTANCE_ID` para distinguir réplicas em scrape. |
| `/health/ready` | probe `SELECT 1` no Postgres com timeout `1500 ms` | Retorna `503` + `status: "degraded"` quando o probe falha; `200` caso contrário. Em `NODE_ENV=test` o probe é omitido. `/health/live` continua sempre `200`. |
| `/uploads` (estático) | `etag: true`, `maxAge: 7d`, `immutable`, `dotfiles: deny`, `fallthrough: false`, `index: false` | Endurece o `express.static` para evitar listagem, dotfiles e relisten ao 404. |
| `express.urlencoded` | `extended: false` | Usa o parser `querystring` nativo; só os formulários HTML de aprovação dependem dele e carregam `{ token, reason? }`. |
| Upload de thumbnail | multer + validação magic-bytes via `sharp().metadata()` | Allowlist: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. `MulterError` (size limit e afins) é convertido para `400 BAD_REQUEST`, não `500`. |

## Email outbox

Quando `REGISTRATION_EMAIL_OUTBOX_ENABLED=true` e a tabela
`registration_email_outbox` existe, os emails de aprovação de cadastro e de
acesso `Client -> Agent` são enfileirados e processados pelo worker. Isso evita
que requests em lote fiquem presos em múltiplos envios SMTP; em ambiente de
teste ou quando a tabela não existe, o código cai para envio direto.

## Manutencao de dados Agent

| Variável                                            | Defeito | Notas                                                                                      |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `AGENT_PROFILE_REVISION_RETENTION_DAYS`             | `180`   | Retencao do historico `agent_profile_revisions` (snapshots versionados do perfil).         |
| `AGENT_PROFILE_IDEMPOTENCY_RETENTION_DAYS`          | `30`    | TTL operacional para `agent_profile_write_idempotencies`; evita idempotencia eterna na BD. |
| `AGENT_PROFILE_MAINTENANCE_INTERVAL_MINUTES`        | `1440`  | Cadencia do scheduler que poda revisoes antigas e chaves de idempotencia expiradas.        |
| `AGENT_PROFILE_MAINTENANCE_PRUNE_BATCH_SIZE`        | `5000`  | Batch de prune para tabelas de perfil do agente.                                           |
| `CLIENT_AGENT_ACCESS_EXPIRY_SWEEP_INTERVAL_MINUTES` | `60`    | Cadencia do sweep que fecha pedidos `pending` cujo token de aprovacao expirou.             |
| `CLIENT_AGENT_ACCESS_EXPIRY_SWEEP_BATCH_SIZE`       | `1000`  | Batch do sweep de expiracao `Client -> Agent`.                                             |

## Socket.IO (Engine.IO)

| Variável                                                   | Defeito                                            | Notas                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `SOCKET_IO_SERVE_CLIENT`                                   | `false`                                            | Não servir o bundle `socket.io` a partir deste servidor (hub API).    |
| `SOCKET_IO_HTTP_COMPRESSION`                               | ver tabela _production_; senão `true`              | Compressão nas respostas **polling**; `false` se só usas `websocket`. |
| `SOCKET_IO_PING_INTERVAL_MS` / `SOCKET_IO_PING_TIMEOUT_MS` | _(omitido)_                                        | Heartbeat Engine.IO (defaults 25000 / 20000 ms).                      |
| `SOCKET_IO_TRANSPORTS`                                     | ver tabela _production_; senão `websocket,polling` | Produção sem variável: só `websocket` (menos CPU/handshake).          |
| `SOCKET_IO_PER_MESSAGE_DEFLATE`                            | `false`                                            | Evita deflate WS duplicado com `PayloadFrame`.                        |
| `SOCKET_IO_MAX_HTTP_BUFFER_BYTES`                          | `10485760`                                         | Teto alinhado a frames de 10 MiB.                                     |

## Metricas especificas de `/consumers`

As seguintes familias novas ajudam a observar custo e confiabilidade do namespace
client-facing:

- `plug_socket_consumers_active_connections{principal_type=...}`
- `plug_socket_consumers_auth_rejected_total{reason=...}`
- `plug_socket_consumers_guard_db_*`
- `plug_socket_consumers_commands_aborted_on_disconnect_total`
- `plug_socket_consumers_profile_push_*`

Uso recomendado:

1. acompanhar `guard_db_avg_ms` / `guard_db_max_ms` antes de mexer em cache
2. acompanhar `commands_aborted_on_disconnect_total` para ver churn de sockets
3. acompanhar `profile_push_fanout_*` e `profile_push_coalesced_total` em rajadas de catalogo

## Validacao de `agent:register` (zod)

O hub valida o payload `agent:register` recebido contra o schema zod
`agentRegisterPayloadSchema` (`src/shared/validators/agent_register.ts`),
alinhado a `agent.register.schema.json` do `plug_agente`:

- `agentId` obrigatorio, string nao vazia (trim aplicado)
- `timestamp` opcional para back-compat com agentes antigos; quando enviado,
  precisa ser ISO-8601 valido
- `capabilities` obrigatorio com `protocols`, `encodings`, `compressions`
  (arrays nao vazios); `extensions` e `limits` defaultam a `{}` quando
  ausentes
- a tolerancia para `timestamp` ausente e para `extensions` / `limits`
  omitidos e uma compatibilidade **temporaria** com agentes antigos; o contrato
  publicado mais recente no `plug_agente` ja os trata como presentes no
  handshake atual
- `profile` opcional (objeto livre, validado em sync downstream)

Toda rejeicao sai pelo evento dedicado **`agent:register_error`** em **JSON
puro** (NAO `PayloadFrame`) com `{ code, reason, message, details? }`. Tabela
completa de `reason` em `docs/api_rest_bridge.md` -> _Falhas de `agent:register` ate o
ownership ser criado_ e `docs/migracao_plug_agente_namespaces.md`. Politica de
sessao: `SOCKET_AGENT_SESSION_POLICY` e (opcional) `SOCKET_AGENT_REGISTER_RATE_LIMIT_*`
na tabela de socket acima.

**Varias instancias do hub:** o registo canónico por `agentId` e os limiters em memória (`SOCKET_AGENT_REGISTER_*`, cache de bind) aplicam-se **por processo**. Com varias réplicas à frente do mesmo load balancer, dois agentes com o mesmo ID podem ficar ligados a hubs diferentes salvo **afinidade de sessão** (sticky) ao mesmo processo ou outro mecanismo distribuído. Ver `docs/nginx_production.md` (sticky Socket.IO), `HUB_INSTANCE_ID` / header `X-Hub-Instance-Id`, e `docs/scaling_and_roadmap.md`.

## Ownership de agentes

O ownership oficial do agente nasce em `agent:register`, depois de um `agent-login` válido. Quando o registo traz `profile`, `profile_version` e `profile_updated_at`, o hub persiste esse snapshot versionado e evita o RPC extra. Agentes legados ou registos sem snapshot completo continuam caindo para `agent.getProfile`, chamado com `include_diagnostics=false` para manter o sync barato. O resultado RPC pode incluir `profile_version` (contador monotónico no servidor); o hub usa-o para ordenar o _pull sync_ e detetar divergência quando a versão coincide mas o conteúdo do perfil não bate com o catálogo. Não existem mais variáveis de ambiente nem rate limits dedicados ao antigo fluxo HTTP de self-service bind em `/api/v1/me/agents`, e o catálogo também não aceita mais criação/edição manual por HTTP; por gestão administrativa, apenas a desativação permanece exposta. Atualização self-service pelo próprio agente (fora do registo) está em `PATCH /api/v1/agents/{agentId}/profile`, documentada no OpenAPI (`/docs`, `/docs.json`), e também em `agent:profile.update` no namespace `/agents`.

## Leitura recomendada

| Topico                                                        | Documento                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| REST bridge, timeouts, rate limit                             | `docs/api_rest_bridge.md`                                               |
| Relay Socket, quotas                                          | `docs/socket_relay_protocol.md`                                         |
| Throughput hub ↔ agente                                       | `docs/performance_hub_agent.md` (presets `.env`, checklist operacional) |
| Metricas e paineis                                            | `docs/observability.md`                                                 |
| Estados de utilizador, bloqueio admin, metricas `plug_auth_*` | `docs/user_status.md`                                                   |
| SSE, Redis, multi-instancia, OTel                             | `docs/scaling_and_roadmap.md`                                           |
