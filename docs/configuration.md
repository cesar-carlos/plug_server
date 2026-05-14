# Configuracao

## Fonte de verdade para defaults

- **Variaveis**: valores por defeito e parsing em [`src/shared/config/env.ts`](../src/shared/config/env.ts) (Zod `.default()` / `preprocess`).
- **Exemplo local**: [`.env.example`](../.env.example) (copiar para `.env`).
- **Documentacao narrativa**: `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md`, `docs/performance_hub_agent.md`, `docs/user_status.md` (estados de utilizador e bloqueio).
- **Mapa da documentacao**: `docs/README.md`.
- **Runtime alvo**: Node `22.13.x` LTS (`.nvmrc`, `package.json.engines` e CI).

Evite duplicar numeros em varios sitios sem atualizar `env.ts`; quando duvidar, confira o ficheiro de env ou `.env.example`.

### `HUB_INSTANCE_ID` (opcional)

| Variável          | Defeito   | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_INSTANCE_ID` | _(vazio)_ | Quando definida (string não vazia), o middleware global `hubInstanceIdMiddleware` adiciona o header HTTP `X-Hub-Instance-Id` com este valor a **toda resposta Express** (REST sob `/api/v1`, `/auth`, Swagger, `/metrics`, 404). Permite ao cliente validar afinidade de sessão (sticky) em qualquer endpoint, e correlacionar logs/métricas com a réplica que processou cada request. O campo JSON `isHubConnected` continua a ser por processo. Receitas de sticky session em `docs/nginx_production.md` § 12. |

### `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED` (opcional)

| Variável                                                   | Defeito | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED`                 | `true`  | Gateia o registro do handler de broadcast `client:agent.profile.updated` no namespace `/consumers`. Default mantém o comportamento sempre-ativo (clientes aprovados recebem push em mudanças do catálogo do agente). Setar `false` é um kill-switch operacional: o resto do `/consumers` (relay, consultas, agents:command) segue funcionando, e os clientes caem em modo polling para ler `profileVersion`. Mudança requer restart (Zod parseia `process.env` no boot). |
| `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS`       | `1000`  | TTL do cache em memória que guarda, por agente, os IDs de clients ativos com acesso aprovado para fan-out de perfil. Mantém o push barato em rajadas de atualização de catálogo sem reter listas por muito tempo. |
| `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE`     | `5000`  | Teto de entradas desse cache por processo. Quando enche, a entrada mais antiga é removida, evitando crescimento sem limite em bases com muitos agentes. |
| `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS`  | `30000` | Sweep periódico best-effort que reconcilia rooms `consumer:client-agent:{clientId}:{agentId}` para sockets `/consumers` já ligados. Fecha a lacuna entre aprovação/revogação e membership real quando um join/leave ao vivo falha ou quando uma réplica perde timing. `0` desativa. |

| `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY`  | `8`     | Limite de concorrÃªncia por tick para leituras `listApprovedAgentIds(...)` e ajustes de room. Evita rajadas de banco em bases com muitos clients ligados. |
| `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK` | `200` | OrÃ§amento de `clientId`s processados por tick. Excedente fica para o tick seguinte, com cursor rotativo estÃ¡vel. |
| `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS` | `1000` | Jitter aleatÃ³rio aplicado sÃ³ ao primeiro tick do processo, para evitar sweeps sincronizados entre rÃ©plicas apÃ³s restart. |

O handshake do consumidor entra primeiro apenas nas rooms base de identidade
(`consumer:principal:*` e `consumer:client:*`) e envia `connection:ready`
antes do custo de materializar `consumer:client-agent:*` e
`consumer:agent-profile:*`. Esse backfill acontece de forma assÃ­ncrona logo
apÃ³s o ready e usa o mesmo orÃ§amento/concurrency do reconcile periÃ³dico.

### `SOCKET_CONSUMER_ROLES` (opcional)

| Variável                | Defeito             | Notas                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_CONSUMER_ROLES` | `user,admin,client` | Lista separada por vírgulas de `role` JWT permitidas no handshake do namespace Socket.IO **`/consumers`**. O literal **`client`** é necessário para apps Colmeia (principal `Client`). Se a variável listar só `user,admin`, o processo **acrescenta** `client` no parse (ver `parseSocketConsumerRolesValue` em `env.ts`) e regista `INFO` `socket_consumer_roles_ensured_client` no arranque. |

### `SOCKET_AUTH_REQUIRED` (opcional)

`socket:event.subscribe`, `socket:event.unsubscribe` e `socket:event.publish`
tambem reaplicam a validacao de conta activa por evento. O custo dessa
revalidacao segue `SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS`: com TTL `0`, cada
evento consulta a fonte de verdade; com TTL > `0`, o hub reutiliza o snapshot
activo do socket dentro da janela.

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_AUTH_REQUIRED` | `true` | Quando `false`, o middleware do namespace **`/agents`** pode aceitar ligacao **sem** token no handshake (modo desenvolvimento / compat). Em **produção** mantém `true`. O namespace **`/consumers`** continua a exigir JWT válido no handshake independentemente desta flag (ver `docs/socket_client_sdk.md`). |

### Checklist produção (smoke socket / Colmeia)

1. **`APP_BASE_URL`** e **`DATABASE_URL`**: o host da URL pública da API e o host da base devem parecer o **mesmo ambiente** (ex.: não misturar Postgres em `localhost` com `APP_BASE_URL` apontando para produção). O arranque regista `WARN` `env_world_alignment_mismatch` quando detecta esse desalinhamento.
2. **Outbox de e-mails de registo**: monitorizar o log `registration_email_outbox_health` (agregado a cada ~10 min quando há fila, erros ou dead letters). Acúmulo persistente indica falha de SMTP ou fila bloqueada.
3. **`SOCKET_CONSUMER_ROLES`**: no PID, confirmar o valor; se faltar o literal `client` na string, o runtime acrescenta (ver tabela acima) e o efeito final inclui `client`.
4. **`SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED`**: `true` ou ausente; `false` desliga push de catálogo (polling no app). Manter `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS=1000` e `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE=5000` como ponto inicial; subir apenas se métricas mostrarem churn excessivo.
5. **`SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS`**: usar `30000` como baseline. Reduza para `5000`-`10000` apenas se a operação exigir convergência mais rápida e as métricas `plug_socket_consumer_client_agent_room_reconcile_*` mostrarem custo aceitável.
6. **`POST /api/v1/agents/commands`** com agente offline mas **já** registado nesse worker: resposta **200** com `response.item.error.code === -32000` e `data.reason === agent_disconnected_at_dispatch` quando o JSON-RPC tem `id` correlacionável (ver tabela _Erros HTTP_ em `docs/api_rest_bridge.md`).
7. **Multi-réplica**: `HUB_INSTANCE_ID` + header `X-Hub-Instance-Id` estável entre pedidos do mesmo cliente; sticky no nginx — `docs/nginx_production.md` § 12.
8. **Duplicados só por maiúsculas** (antes de migrar para `citext`): correr `npm run db:email:dup-scan` na base alvo; corrigir duplicados antes de `prisma migrate deploy`.

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
| `SOCKET_RELAY_STREAM_IDLE_TIMEOUT_MS`           | `30000`                              | TTL de inatividade para streams relay ja abertos (`stream_id`). Reinicia em `rpc:chunk`, `rpc:complete` e `rpc:stream.pull`; ao estourar o hub emite `relay:rpc.complete` com erro e remove rotas/flow state.       |
| `SOCKET_RELAY_STREAM_MAX_LIFETIME_MS`           | `300000`                             | Vida maxima absoluta de uma stream relay aberta. Nao reinicia com trafego; evita vazamento quando o agente nunca envia `rpc:complete`.                                                                                |
| `AGENT_SQL_BULK_INSERT_MAX_ROWS`                | `50000`                              | Teto de linhas aceitas pelo hub em `sql.bulkInsert` antes de montar o `PayloadFrame`. Cargas maiores devem ser quebradas em lotes.                                                                                   |
| `AGENT_SQL_BULK_INSERT_MAX_JSON_BYTES`          | `10485760`                           | Teto UTF-8 do JSON serializado de `params` em `sql.bulkInsert`; protege memoria do hub antes de encaminhar ao agente.                                                                                                 |
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
| `SOCKET_IO_REDIS_ADAPTER_URL`                           | _(vazio)_ | Redis adapter opcional do Socket.IO para rooms/pubsub entre replicas. Quando configurado, broadcasts de rooms (`client:custom.*`, rooms de client/principal etc.) atravessam replicas. Falha de conexao cai para adapter em memoria. Sticky sessions ainda sao recomendadas para relay, pending requests e presenca de agentes. |
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
| `REST_SOCKET_EVENT_MAX_RECIPIENTS`         | `0`       | Teto opcional de fan-out por publicacao. `0` = ilimitado; quando estoura, retorna `503`. Sem Redis adapter a contagem usa o mapa local de rooms; com `SOCKET_IO_REDIS_ADAPTER_URL`, a contagem usa `fetchSockets()` para cobrir replicas remotas antes de emitir. Em producao com rooms grandes defina um teto > 0 para shedding previsivel. |
| `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` | `2000`   | Valor (ms) de `error.details.retry_after_ms` nesse `503` (REST e `socket:event.publish`); **não** é a janela do rate limit de publicação (`REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`). |
| `REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS`     | `300000`  | Janela em memoria para deduplicar publicacoes com `Idempotency-Key` (REST) ou `idempotencyKey` no corpo (`socket:event.publish`). **`0` desativa o armazenamento**: a chave ainda pode ser validada em formato, mas **nao** ha replay guardado (cada pedido emite de novo). Com TTL > 0, pedidos **concorrentes** com a mesma chave no **mesmo processo** sao serializados para evitar dupla emissao antes da escrita no cache. **Sequencial** (um apos o outro) com TTL `0`: o segundo pedido com a mesma chave **pode voltar a emitir** — use TTL > 0 para replay entre tentativas. |
| `REST_SOCKET_EVENT_IDEMPOTENCY_MAX_ENTRIES` | `10000`  | Maximo de respostas idempotentes retidas por processo. Quando o mapa enche, entradas sao expulsas pela **ordem de insercao** (primeira chave do `Map`) ate haver espaco — nao e eviction por `expiresAtMs` mais antigo; o prune por TTL continua a correr em escritas. |
| `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` | `0` | Maximo de cadeias de serializacao **distintas** `(clientId, idempotencyKey)` em voo no processo; `0` = ilimitado. Acima do teto, novas chaves distintas recebem `503` ate concluirem publicacoes em curso; `error.details.retry_after_ms` segue `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (como no `503` de fan-out). Nao coordena entre replicas. |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL` | _(vazio)_ | Redis opcional para replay/conflito de `Idempotency-Key` entre replicas. Quando vazio, segue local por processo. Use junto de `SOCKET_IO_REDIS_ADAPTER_URL` em multi-replica. |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_TTL_MS` | `5000` | TTL do lock `SET NX` que protege a primeira emissao de uma chave idempotente entre replicas. |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_WAIT_MS` | `750` | Quanto outra replica espera pela resposta idempotente antes de retornar `503` retryable. `0` = fail-fast. |
| `REST_SOCKET_EVENT_HTTP_JSON_BODY_LIMIT` | _(derivado)_ | Limite do `express.json` **apenas** para `POST /api/v1/client/me/socket-events` com `Content-Type: application/json`. Vazio: calcula ~110% do pior caso UTF-8 (payload + anexos inline em base64) a partir de `REST_SOCKET_EVENT_*`. O `REQUEST_BODY_LIMIT` global continua baixo para as demais rotas. |

O hub tambem calcula `socketEventPublishRawJsonMaxBytes` (sem variavel de ambiente dedicada): e o teto em bytes UTF-8 para o JSON bruto de `socket:event.publish` antes do Zod, derivado de `REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES` e dos tetos de anexos REST, **limitado por** `SOCKET_IO_MAX_HTTP_BUFFER_BYTES` (pacote Engine.IO). Se exceder o buffer, o hub regista `WARN` no arranque — mensagens maiores que o buffer podem ser cortadas antes do handler.

**Redis (rate limits, chaves ilustrativas):**

| Canal | Prefixo / scope | Sufixo de identidade (Client JWT `sub`) |
| ----- | ----------------- | ---------------------------------------- |
| HTTP `POST .../socket-events` | `plug_rl:client_socket_event_publish:` (`express-rate-limit`) | `client:<sub>` (ou `client:anonymous` sem `sub`) |
| Socket `socket:event.publish` | `plug_socket_rl:client_socket_event_publish:` | `client:<sub>` |
| Idempotencia distribuida `client:custom.*` | `plug_socket_event_idem:` / `plug_socket_event_idem_lock:` | SHA-256 de `(clientId, idempotencyKey)` |

Os dois sistemas sao independentes (prefixos diferentes); contadores REST e Socket nao se misturam.

O endpoint REST e `socket:event.publish` enviam para clientes
inscritos em `client:custom.*` via `socket:event.subscribe`. Em multi-replica
sem adapter distribuido do Socket.IO, a entrega alcanca somente sockets
conectados a mesma replica que processou o pedido (REST ou Socket). Com
`SOCKET_IO_REDIS_ADAPTER_URL`, o broadcast da room atravessa replicas; mantenha
sticky sessions para relay/conversas e para estado de agente ainda local.

Quando o adapter Redis esta activo mas a contagem distribuida de destinatarios
falha, o hub so emite em modo **best-effort** se a sala local estiver abaixo do
teto conservador configurado. Apos falhas consecutivas, o circuito de contagem
distribuida abre e novos publishes retornam `503` durante uma janela curta.

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
| `DATABASE_TRANSACTION_RETRY_MAX_ATTEMPTS` / `DATABASE_TRANSACTION_RETRY_BASE_DELAY_MS` | `3` / `25` | Retry curto para conflitos transientes em transações Prisma críticas (`40001`, `40P01`, `P2034`). `1` desativa retry. |
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

## Rollout de indices grandes

Quando uma migration adicionar índices novos em tabelas quentes ou grandes,
trate o rollout como operação separada da entrega da aplicação:

1. use `CREATE INDEX CONCURRENTLY` fora de transação no Postgres de produção;
2. crie um índice de cada vez e acompanhe locks, I/O e `pg_stat_progress_create_index`;
3. só depois aplique a migration final do Prisma ou marque a etapa como já executada, conforme o teu playbook;
4. mantenha rollback simples: a app nova deve funcionar antes e depois do índice existir.

O objetivo é evitar lock pesado de escrita durante deploy e reduzir risco em
bases com cardinalidade alta.

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

## Adendo: publish degradado de `client:custom.*`

Esta rodada acrescentou tres controlos operacionais para o caminho
`POST /api/v1/client/me/socket-events` e `socket:event.publish` quando o
Socket.IO Redis adapter esta activo, mas a contagem distribuida da room falha:

| Variavel | Defeito | Notas |
| --- | --- | --- |
| `REST_SOCKET_EVENT_BEST_EFFORT_LOCAL_MAX_RECIPIENTS` | `256` | Teto local conservador para permitir emit em modo best-effort enquanto `fetchSockets()` falha. Acima disso, o hub responde `503` em vez de continuar fan-out sem controlo. |
| `REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_THRESHOLD` | `5` | Numero de falhas consecutivas de contagem distribuida antes de abrir o circuito local de degradacao. |
| `REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_OPEN_MS` | `30000` | Janela durante a qual o circuito permanece aberto; nesse periodo, novos publishes recebem `503` retryable. |

Sem Redis adapter activo, o caminho continua a usar a contagem local da room e
estes controlos nao entram em jogo. Com Redis adapter activo, o comportamento
passa a ser:

1. tentar contagem distribuida;
2. se funcionar, aplicar `REST_SOCKET_EVENT_MAX_RECIPIENTS` normalmente;
3. se falhar, permitir publish degradado apenas abaixo do teto local;
4. se as falhas se repetirem, abrir o circuito e devolver `503` ate a janela expirar.
