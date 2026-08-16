# Configuracao

## Fonte de verdade para defaults

- **Variaveis**: valores por defeito e parsing em `[src/shared/config/env.ts](../src/shared/config/env.ts)` (Zod `.default()` / `preprocess`).
- **Exemplo local**: `[.env.example](../.env.example)` (copiar para `.env`).
- **Documentacao narrativa**: `docs/api/api_rest_bridge.md`, `docs/socket/socket_relay_protocol.md`, `docs/performance/performance_hub_agent.md`, `docs/api/user_status.md` (estados de utilizador e bloqueio).
- **Mapa da documentacao**: `docs/README.md`.
- **Runtime alvo**: Node `24.18.x` (`.nvmrc`, `package.json.engines` e CI).

Evite duplicar numeros em varios sitios sem atualizar `env.ts`; quando duvidar, confira o ficheiro de env ou `.env.example`.

### `HUB_INSTANCE_ID` (opcional)

| Variável          | Defeito   | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_INSTANCE_ID` | _(vazio)_ | Quando definida (string não vazia), o middleware global `hubInstanceIdMiddleware` adiciona o header HTTP `X-Hub-Instance-Id` com este valor a **toda resposta Express** (REST sob `/api/v1`, `/auth`, Swagger, `/metrics`, 404). **Obrigatório em produção** quando presença Redis está activa (`AGENT_HUB_PRESENCE_` / `SOCKET_IO_REDIS_ADAPTER_URL`). Com presença activa, `isHubConnected` em `GET /client/me/agents` reflecte ligação em qualquer réplica do cluster. Receitas de sticky session em `docs/infrastructure/nginx_production.md` § 12. |

### `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED` (opcional)

| Variável                                                  | Defeito | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED`                | `true`  | Gateia o registro do handler de broadcast `client:agent.profile.updated` no namespace `/consumers`. Default mantém o comportamento sempre-ativo (clientes aprovados recebem push em mudanças do catálogo do agente). Setar `false` é um kill-switch operacional: o resto do `/consumers` (relay, consultas, agents:command) segue funcionando, e os clientes caem em modo polling para ler `profileVersion`. Mudança requer restart (Zod parseia `process.env` no boot). |
| `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS`      | `1000`  | TTL do cache em memória que guarda, por agente, os IDs de clients ativos com acesso aprovado para fan-out de perfil. Mantém o push barato em rajadas de atualização de catálogo sem reter listas por muito tempo.                                                                                                                                                                                                                                                        |
| `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE`    | `5000`  | Teto de entradas desse cache por processo. Quando enche, a entrada mais antiga é removida, evitando crescimento sem limite em bases com muitos agentes.                                                                                                                                                                                                                                                                                                                  |
| `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS` | `30000` | Sweep periódico best-effort que reconcilia rooms `consumer:client-agent:{clientId}:{agentId}` para sockets `/consumers` já ligados. Fecha a lacuna entre aprovação/revogação e membership real quando um join/leave ao vivo falha ou quando uma réplica perde timing. `0` desativa.                                                                                                                                                                                      |

| `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_CONCURRENCY` | `8` | Limite de concorrência por tick para leituras `listApprovedAgentIds(...)` e ajustes de room. Evita rajadas de banco em bases com muitos clients ligados. |
| `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_MAX_CLIENTS_PER_TICK` | `200` | Orçamento de `clientId`s processados por tick. Excedente fica para o tick seguinte, com cursor rotativo estável. |
| `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS` | `1000` | Jitter aleatório aplicado só ao primeiro tick do processo, para evitar sweeps sincronizados entre réplicas após restart. |

O handshake do consumidor entra primeiro apenas nas rooms base de identidade
(`consumer:principal:*` e `consumer:client:*`) e envia `connection:ready`
antes do custo de materializar `consumer:client-agent:*` e
`consumer:agent-profile:*`. Esse backfill acontece de forma assíncrona logo
após o ready e usa o mesmo orçamento/concurrency do reconcile periôdico.

`grantClientAccess` **e atraso cross-replica:** quando um acesso e aprovado
(`approveByToken` / `approveByOwner`), o fast path `grantClientAccess` corre no
processo que tratou a aprovacao e tenta `join` imediato nas rooms
`consumer:client-agent:{clientId}:{agentId}` (e derivadas) para sockets ja
ligados em `client:{clientId}`. Com `SOCKET_IO_REDIS_ADAPTER_URL`, o
`fetchSockets` na room base inclui sockets noutras replicas e o join e
distribuido; sem adapter, so sockets **locais** recebem o join imediato. Se o
fast path falhar (erro de join/fetch) ou o cliente estiver noutra replica sem
visibilidade, o **reconcile periodico** corrige drift: pior caso, ate
`SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS` (defeito `30000`) mais
jitter de arranque (`SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_START_JITTER_MS`).
Clientes multi-replica devem tratar pushes iniciais como best-effort e usar REST
para catalogo/acesso completo; metricas `plug_socket_consumer_client_agent_room_grant_*`
e `plug_socket_consumer_client_agent_room_reconcile_*` ajudam a dimensionar convergencia.
Ver tambem `docs/studies/scaling_and_roadmap.md` (salas apos aprovacao).

### `SOCKET_CONSUMER_ROLES` (opcional)

| Variável                | Defeito             | Notas                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_CONSUMER_ROLES` | `user,admin,client` | Lista separada por vírgulas de `role` JWT permitidas no handshake do namespace Socket.IO `/consumers`. O literal `client` é necessário para apps Colmeia (principal `Client`). Se a variável listar só `user,admin`, o processo **acrescenta** `client` no parse (ver `parseSocketConsumerRolesValue` em `env.ts`) e regista `INFO` `socket_consumer_roles_ensured_client` no arranque. |

### `SOCKET_AUTH_REQUIRED` (opcional)

`socket:event.subscribe`, `socket:event.unsubscribe` e `socket:event.publish`
tambem reaplicam a validacao de conta activa por evento. O custo dessa
revalidacao segue `SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS`: com TTL `0`, cada
evento consulta a fonte de verdade; com TTL > `0`, o hub reutiliza o snapshot
activo do socket dentro da janela.

| Variável               | Defeito | Notas                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_AUTH_REQUIRED` | `true`  | Handshake JWT do namespace `/agents`. Quando `false`, o middleware aceita ligacao **sem** token **apenas** com `NODE_ENV=test`; em **produção** o bootstrap **aborta** se a flag estiver desligada (arranque regista `WARN` `socket_agent_auth_bypass_`). O namespace `/consumers` continua a exigir JWT válido no handshake independentemente desta flag (ver `docs/socket/socket_client_sdk.md`). |

### Idle enforcement (Socket)

Sweeps periodicos desligam sockets inactivos para libertar memoria e salas. `touch` em trafego relevante (register, heartbeat, RPC, relay, etc.) reinicia o relogio. `0` no timeout desactiva a politica; `0` no sweep desactiva o scheduler em background.

| Variável                                 | Defeito            | Notas                                                                                                                                                                            |
| ---------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_AGENT_IDLE_TIMEOUT_MS`           | `1800000` (30 min) | Desliga sockets `/agents` registados sem actividade. Metrica: `plug_agent_idle_timeout_disconnect_total`.                                                                        |
| `SOCKET_AGENT_IDLE_SWEEP_INTERVAL_MS`    | `60000`            | Cadencia do sweep em background para `SOCKET_AGENT_IDLE_TIMEOUT_MS`.                                                                                                             |
| `SOCKET_CONSUMER_IDLE_TIMEOUT_MS`        | `1800000` (30 min) | Desliga sockets `/consumers` ligados inactivos; emite `app:error` com `code: CONSUMER_IDLE_TIMEOUT` antes do disconnect. Metrica: `plug_consumer_idle_timeout_disconnect_total`. |
| `SOCKET_CONSUMER_IDLE_SWEEP_INTERVAL_MS` | `60000`            | Cadencia do sweep em background para `SOCKET_CONSUMER_IDLE_TIMEOUT_MS`.                                                                                                          |

### Checklist produção (smoke socket / Colmeia)

1. `APP_BASE_URL` e `DATABASE_URL`: o host da URL pública da API e o host da base devem parecer o **mesmo ambiente** (ex.: não misturar Postgres em `localhost` com `APP_BASE_URL` apontando para produção). O arranque regista `WARN` `env_world_alignment_mismatch` quando detecta esse desalinhamento.
2. **Outbox de e-mails de registo**: monitorizar o log `registration_email_outbox_health` (agregado a cada ~10 min quando há fila, erros ou dead letters). Acúmulo persistente indica falha de SMTP ou fila bloqueada.
3. `SOCKET_CONSUMER_ROLES`: no PID, confirmar o valor; se faltar o literal `client` na string, o runtime acrescenta (ver tabela acima) e o efeito final inclui `client`.
4. `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED`: `true` ou ausente; `false` desliga push de catálogo (polling no app). Manter `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_TTL_MS=1000` e `SOCKET_CLIENT_AGENT_PROFILE_RECIPIENT_CACHE_MAX_SIZE=5000` como ponto inicial em dev; em staging/prod ver secção _Performance tuning_ (`10000` ms de TTL recomendado quando métricas mostrarem churn).
5. `SOCKET_CONSUMER_CLIENT_AGENT_ROOM_RECONCILE_INTERVAL_MS`: usar `30000` como baseline. Reduza para `5000`-`10000` apenas se a operação exigir convergência mais rápida e as métricas `plug_socket_consumer_client_agent_room_reconcile_*` mostrarem custo aceitável.
6. `POST /api/v1/agents/commands` com agente offline mas **já** registado nesse worker: resposta **200** com `response.item.error.code === -32000` e `data.reason === agent_disconnected_at_dispatch` quando o JSON-RPC tem `id` correlacionável (ver tabela _Erros HTTP_ em `docs/api/api_rest_bridge.md`).
7. **Multi-réplica**: `HUB_INSTANCE_ID` + header `X-Hub-Instance-Id` estável entre pedidos do mesmo cliente; sticky no nginx — `docs/infrastructure/nginx_production.md` § 12.
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

| Variável                                          | Defeito                                          | Notas                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAYLOAD_FRAME_COMPRESS_MIN_BYTES`                | `4096`                                           | `encodePayloadFrame` / `encodePayloadFrameBridge`: abaixo deste tamanho UTF-8 serializado usa `cmp: none` (evita CPU de gzip+base64 em frames pequenos). `0` desativa o limiar global.                                                                                                                                                                       |
| `PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES`              | `524288` (512 KiB)                               | Só tenta gzip quando o JSON UTF-8 não excede este tamanho; ver `docs/performance/performance_hub_agent.md`.                                                                                                                                                                                                                                                  |
| `PAYLOAD_FRAME_GZIP_LEVEL`                        | ver tabela _production_ acima; senão _(omitido)_ | Nível zlib `1`–`9` para gzip do hub; fora do ramo produção omitir = default Node (~6).                                                                                                                                                                                                                                                                       |
| `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES`         | `131072` (128 KiB)                               | Hub→agente (`encodePayloadFrameBridge`): JSON elegível para gzip com pelo menos este tamanho usa **gzip assíncrono**. `0` = sempre síncrono.                                                                                                                                                                                                                 |
| `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` | `1`                                          | Hub **inbound** (`decodePayloadFrameAsync`): `cmp: gzip` com payload comprimido ≥ este tamanho usa **gunzip assíncrono**. `0` = sempre síncrono.                                                                                                                                                                                                             |
| `SOCKET_AGENT_KNOWN_IDS_MAX`                      | `0`                                              | Teto do conjunto de `agentId` “conhecidos” (offline) para REST; acima disto remove-se IDs **desligados** até ficar abaixo do limite. `0` = sem limite.                                                                                                                                                                                                       |
| `SOCKET_AGENT_PROTOCOL_READY_GRACE_MS`            | `100`                                            | Fallback de estabilização após `agent:register` antes do primeiro `rpc:request`; o hub libera mais cedo com `agent:heartbeat` e também suporta `agent:ready` explícito quando o agente anuncia `extensions.protocolReadyAck`. Reduz corrida com `protocol_not_ready` do `plug_agente`.                                                                       |
| `SOCKET_AGENT_SESSION_POLICY`                     | `reject_active`                                  | `reject_active`: recusa um segundo `agent:register` enquanto outro socket canonico do mesmo `agentId` estiver ligado neste processo. `takeover_disconnect_previous`: substitui e desliga o socket anterior (emite `agent:session.superseded` antes do disconnect). `legacy_silent_takeover`: comportamento antigo (substitui registo sem forcar disconnect). |
| `SOCKET_AGENT_REGISTER_RATE_LIMIT_WINDOW_MS`      | `0`                                              | Janela (ms) para limitar tentativas de `agent:register` por par `(userId, agentId)`. `0` desativa. Corre **antes** do bind na BD para cortar rajadas sem stress na base.                                                                                                                                                                                     |
| `SOCKET_AGENT_REGISTER_RATE_LIMIT_MAX`            | `0`                                              | Maximo de `agent:register` permitidos por janela por `(userId, agentId)`. `0` desativa.                                                                                                                                                                                                                                                                      |
| `AGENT_REGISTER_BIND_CACHE_TTL_MS`                | `5000`                                           | Apos `assertOwnershipEligible`, positivos podem omitir `ensureCatalogAgentExistsForIdentity` + `bindIfUnbound` ate expirar (rajadas de reconnect). `0` desliga. Invalidacao com os mesmos hooks que `invalidateAccessCache*` / `AGENT_ACCESS_CACHE_*`.                                                                                                       |
| `AGENT_REGISTER_BIND_CACHE_MAX_SIZE`              | `2000`                                           | Tamanho maximo do cache em memoria do bind-register; `0` = sem limite de entradas (TTL continua a aplicar-se por entrada).                                                                                                                                                                                                                                   |
| `SOCKET_AGENT_PROFILE_SYNC_MAX_CONCURRENT`        | `8`                                              | Máximo de syncs `agent.getProfile` em paralelo após `agent:register` (reduz rajada quando muitos agentes reconectam).                                                                                                                                                                                                                                        |
| `AGENT_HEALTH_POLL_ENABLED`                       | `false`                                          | Liga polls agendados de `agent.getHealth` para agentes registados. Desligado por defeito; ativar apenas quando o volume de poll for material.                                                                                                                                                                                                                |
| `AGENT_HEALTH_POLL_INTERVAL_MS`                   | `60000`                                          | Cadência entre polls de `agent.getHealth` por agente elegível.                                                                                                                                                                                                                                                                                               |
| `AGENT_HEALTH_POLL_CONCURRENCY`                   | `8`                                              | Máximo de polls `agent.getHealth` em paralelo no scheduler (evita rajada quando muitos agentes estão online).                                                                                                                                                                                                                                                |
| `PAYLOAD_SIGN_OUTBOUND`                           | `false`                                          | Assina frames de saída com `PAYLOAD_SIGNING_KEY` (HMAC-SHA256 sobre JSON canônico do `PayloadFrame` sem `signature`, com `payload` em base64 e chaves ordenadas). Quando `true`, o hub cacheia strings canônicas de assinatura (LRU 512 entradas) para evitar `canonicalJsonStringify` repetido no hot path.                                                 |
| `PAYLOAD_SIGNING_KEY`                             | _(vazio)_                                        | Chave compartilhada para assinar/verificar `PayloadFrame.signature`. Quando ausente e um frame chega assinado, a verificação **falha**.                                                                                                                                                                                                                      |
| `PAYLOAD_SIGNING_KEY_ID`                          | _(vazio)_                                        | Identificador da chave ativa de saída/verificação (ex.: `hub-2026-q2`). Quando definida, frames recebidos assinados **devem** trazer `signature.key_id` conhecido. Sem essa env e sem chaves anteriores, o hub aceita assinaturas sem `key_id` (modo single-key).                                                                                            |
| `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON`              | `{}`                                             | Objeto JSON `{ "old-key-id": "secret" }` aceito apenas para verificar frames inbound durante rotação. Chave anterior nunca é usada para assinar saída. Ao configurar chaves anteriores, frames assinados sem `key_id` passam a falhar.                                                                                                                       |
| `SOCKET_AGENT_INBOUND_CONTRACT_VALIDATION`        | `strict`                                         | Validação lógica depois do `PayloadFrame`: `strict` rejeita `rpc:response`, chunks, completes e ACKs fora do contrato; `warn` registra métrica/log e continua; `off` desliga.                                                                                                                                                                                |
| `SOCKET_AGENT_ACK_RETRY_ENABLED`                  | `true`                                           | Habilita retry por falta de `rpc:request_ack`/`rpc:batch_ack` somente para requests elegíveis e idempotentes/seguras.                                                                                                                                                                                                                                        |
| `SOCKET_AGENT_ACK_TIMEOUT_MS`                     | `1000`                                           | Janela para aguardar ACK antes de reenviar o mesmo frame elegível.                                                                                                                                                                                                                                                                                           |
| `SOCKET_AGENT_ACK_MAX_RETRIES`                    | `1`                                              | Número máximo de reenvios por falta de ACK. `0` desativa o retry mesmo com a flag ligada.                                                                                                                                                                                                                                                                    |

### `SOCKET_CONNECTION_READY_COMPAT_MODE` (opcional)

Migração do wire format de `connection:ready` nos namespaces `/agents` e `/consumers` (plain JSON legado → `PayloadFrame`).

| Variável                              | Defeito         | Notas                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_CONNECTION_READY_COMPAT_MODE` | `payload_frame` | Formato **outbound** de `connection:ready`. `payload_frame` (defeito) usa `PayloadFrame`; `raw_json` restaura plain JSON legado **apenas na saída**. Remoção prevista `2026-09-30` (`warnIfConnectionReadyLegacyCompatExpired` no arranque). Em `NODE_ENV=production`, o bootstrap **aborta** se a flag estiver em `raw_json` (mesmo padrão que `SOCKET_AUTH_REQUIRED`). Ver `docs/socket/socket_client_sdk.md`. |

### `SOCKET_AGENTS_COMMAND_COMPAT_MODE` (opcional)

Migração do wire format de `agents:command` no namespace `/consumers` (plain JSON legado → `PayloadFrame`).

| Variável                            | Defeito         | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_AGENTS_COMMAND_COMPAT_MODE` | `payload_frame` | Formato **outbound** de `agents:command_response` e `agents:command_stream_`. `payload_frame` (defeito) usa `PayloadFrame`; `raw_json` restaura plain JSON legado **apenas na saída**. Inbound `agents:command` aceita plain JSON e `PayloadFrame` durante a transição. Remoção prevista `2026-09-30` (`warnIfAgentsCommandLegacyCompatExpired` no arranque). Em `NODE_ENV=production`, o bootstrap **aborta** se a flag estiver em `raw_json`. Ver `agentsCommandWireMigration` em `src/shared/constants/agent_bridge_parity.ts`. |

### `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE` (opcional)

Migração do wire format de `agents:stream_pull` no namespace `/consumers` (plain JSON legado → `PayloadFrame` hot-path).

| Variável                                | Defeito         | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE` | `payload_frame` | Formato **outbound** de `agents:stream_pull_response`. `payload_frame` (defeito) usa `PayloadFrame` via hot-path encode; `raw_json` restaura plain JSON legado **apenas na saída**. Inbound `agents:stream_pull` aceita plain JSON e `PayloadFrame` durante a transição. Env **independente** de `SOCKET_AGENTS_COMMAND_COMPAT_MODE`. Remoção prevista `2026-09-30` (`warnIfAgentsStreamPullLegacyCompatExpired` no arranque). Em `NODE_ENV=production`, o bootstrap **aborta** se a flag estiver em `raw_json`. Ver `agentsStreamPullWireMigration` em `src/shared/constants/agent_bridge_parity.ts`. |

## Client thumbnail e password recovery

| Variável                                             | Defeito                   | Notas                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPLOADS_DIR`                                        | `uploads`                 | Diretório base para arquivos locais servidos em `/uploads`. Em produção, usar volume persistente.                                                                                                                                |
| `UPLOADS_PUBLIC_BASE_URL`                            | `APP_BASE_URL + /uploads` | Prefixo público das URLs de thumbnail.                                                                                                                                                                                           |
| `CLIENT_THUMBNAIL_MAX_BYTES`                         | `2097152`                 | Limite do upload da thumbnail (max **10 MiB** em `env.ts`); `client_max_body_size` no Nginx deve ser >= este valor — ver exemplo **11m** em `docs/infrastructure/nginx_production.md` e `deploy/nginx/plug_server.conf.example`. |
| `CLIENT_THUMBNAIL_WIDTH`                             | `256`                     | Largura final da thumbnail após normalização.                                                                                                                                                                                    |
| `CLIENT_THUMBNAIL_HEIGHT`                            | `256`                     | Altura final da thumbnail após normalização.                                                                                                                                                                                     |
| `CLIENT_THUMBNAIL_WEBP_QUALITY`                      | `82`                      | Qualidade da conversão para `webp`.                                                                                                                                                                                              |
| `CLIENT_PASSWORD_RECOVERY_TOKEN_EXPIRES_IN`          | `30m`                     | Expiração do token de recuperação de senha do client.                                                                                                                                                                            |
| `REST_CLIENT_THUMBNAIL_RATE_LIMIT_WINDOW_MS`         | `60000`                   | Janela do rate limit para upload de thumbnail.                                                                                                                                                                                   |
| `REST_CLIENT_THUMBNAIL_RATE_LIMIT_MAX`               | `20`                      | Máximo de uploads de thumbnail por janela.                                                                                                                                                                                       |
| `REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_WINDOW_MS` | `300000`                  | Janela do rate limit para request de recuperação de senha.                                                                                                                                                                       |
| `REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_MAX`       | `10`                      | Máximo de requests de recuperação por janela.                                                                                                                                                                                    |

## REST bridge e auditoria (env)

| Variável                                             | Defeito     | Notas                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_REST_STREAM_PULL_WINDOW_SIZE`                | `256`       | Janela interna ao materializar `sql.execute` em stream no REST (menos round-trips com valores maiores).                                                                                                                                                                      |
| `SOCKET_REST_STREAM_PULL_MAX_WINDOW_SIZE`            | `256`       | Limite maximo anunciado em `agent:capabilities.extensions.maxStreamPullWindowSize` e aplicado pelo hub a qualquer `rpc:stream.pull` gerado/encaminhado. O valor recomendado publicado nunca ultrapassa este maximo; se o agente anunciar teto menor, prevalece o menor teto. |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_BYTES`       | `268435456` | Teto agregado de bytes UTF-8 materializados no REST (resposta inicial + chunks). Complementa o limite por linhas para proteger contra payloads JSONB muito largos.                                                                                                           |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_CHUNKS`      | `100000`    | Teto de `rpc:chunk` aceites na materialização REST. `0` continua a significar ilimitado, mas deixou de ser o default.                                                                                                                                                        |
| `SOCKET_RELAY_STREAM_IDLE_TIMEOUT_MS`                | `30000`     | TTL de inatividade para streams relay ja abertos (`stream_id`). Reinicia em `rpc:chunk`, `rpc:complete` e `rpc:stream.pull`; ao estourar o hub emite `relay:rpc.complete` com erro e remove rotas/flow state. Metrica: `plug_socket_relay_stream_idle_timeouts_total`.       |
| `SOCKET_RELAY_STREAM_MAX_LIFETIME_MS`                | `300000`    | Vida maxima absoluta de uma stream relay aberta. Nao reinicia com trafego; evita vazamento quando o agente nunca envia `rpc:complete`. Metrica: `plug_socket_relay_stream_lifetime_timeouts_total`.                                                                          |
| `SOCKET_RELAY_CONVERSATION_IDLE_TIMEOUT_MS`          | `300000`    | TTL de inatividade para conversas relay abertas sem trafego. Ao expirar o sweep emite `relay:conversation.ended` com `reason: expired` ao consumer **e** ao agente ligado, limpa idempotencia e estado associado. Metrica: `plug_socket_relay_conversations_expired_total`.  |
| `SOCKET_RELAY_CONVERSATION_SWEEP_INTERVAL_MS`        | `60000`     | Cadencia do sweep em background **apenas** para conversas relay inactivas (`SOCKET_RELAY_CONVERSATION_IDLE_TIMEOUT_MS`). Independente do sweep de rate limits.                                                                                                                                                                |
| `SOCKET_RELAY_CONVERSATION_TOUCH_DEBOUNCE_MS`        | `0`         | Intervalo minimo entre writes de `lastSeenAtMs` no hot path de stream (`touchInternalDebounced`). `0` = touch em cada chunk/resposta. Valores como `5000` reduzem writes no registry durante floods de `rpc:chunk`. Nao altera o TTL de idle.                                                                                 |
| `SOCKET_RELAY_CIRCUIT_FAILURE_THRESHOLD`             | `5`         | Falhas consecutivas por agente/canal (`rest` vs `relay`, isolados) antes de abrir o circuit breaker. Rejeita com `503` + `retryAfterMs`.                                                                                                                                                                                      |
| `SOCKET_RELAY_CIRCUIT_OPEN_MS`                       | `30000`     | Janela em que o circuit do agente permanece aberto. Prune de entradas stale no hot path e debounceado (~30 s); o snapshot de metricas continua a podar na hora.                                                                                                                                                               |
| `SOCKET_RELAY_BATCH_ENABLED`                         | `false`     | Gate de `relay:rpc.request.batch`. `false` rejeita o evento; cada item do batch continua a virar um `rpc:request` separado no agente. Ver `docs/socket/socket_relay_protocol.md` ("Relay JSON-RPC batch").                                                                                                                    |
| `SOCKET_RELAY_BATCH_MAX_ITEMS`                       | `32`        | Teto de itens JSON-RPC por envelope `relay:rpc.request.batch` (espelha `HUB_MAX_BATCH_SIZE`).                                                                                                                                                                                                                                 |
| `SOCKET_RELAY_FAST_PATH_FORBIDDEN`                   | `false`     | Kill switch de deploy: ignora `fastPath: true` no envelope e volta ao fluxo de 3 eventos (`relay:rpc.accepted`). Nao existe `SOCKET_RELAY_FAST_PATH_ENABLED` — o opt-in e o campo do envelope. Metrica: `plug_socket_relay_fast_path_forbidden_total`.                                                                        |
| `SOCKET_RATE_LIMIT_SWEEP_INTERVAL_MS`               | `60000`     | Cadencia do sweep de mapas de rate limit Socket + fila outbound relay. Independe do sweep de conversas. Se unset, faz fallback para `SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS`.                                                                                                                                                  |
| `SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS`           | `60000`     | Alias legado do intervalo de sweep outbound/rate-limit. Preferir `SOCKET_RATE_LIMIT_SWEEP_INTERVAL_MS`.                                                                                                                                                                                                                        |
| `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG`             | `200`       | Backlog da fila outbound relay acima do qual o hub entra em shedding (`0` desativa por backlog). Com `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG_EXIT` < entrada, aplica histerese na saida.                                                                                     |
| `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS`              | `250`       | p95 de duracao de jobs outbound acima do qual o hub entra em shedding (`0` desativa por latencia). Com `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_EXIT_MS` < entrada, aplica histerese.                                                                                             |
| `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG_EXIT`        | `0`         | Limiar de backlog para **sair** do shedding (`0` = mesmo valor de `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG`, sem histerese).                                                                                                                                                  |
| `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_EXIT_MS`         | `0`         | Limiar de p95 para **sair** do shedding (`0` = mesmo valor de `SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS`).                                                                                                                                                                      |
| `SOCKET_RELAY_CONSUMER_TRANSPORT_MAX_BUFFERED_BYTES` | `512000`    | Pausa apenas drains de `relay:rpc.chunk` quando o buffer de escrita Socket.IO do consumer excede este teto (`0` desativa). Nao bloqueia `request_ack`, `response` nem `complete`.                                                                                            |
| `SOCKET_METRICS_SAMPLE_RATE`                         | `1`         | Taxa de amostragem (0–1) para contadores de alta frequencia no relay/stream hub (`plug_socket_relay_chunks_forwarded_total`, `plug_socket_relay_chunks_buffered_total`, `plug_socket_relay_stream_pulls_total`). `1` = contagem exacta; `0.1` ≈ 10% dos eventos com escalonamento para totais sem vies. Erros, seguranca e limites continuam exactos. |
| `AGENT_SQL_BULK_INSERT_MAX_ROWS`                     | `50000`     | Teto de linhas aceitas pelo hub em `sql.bulkInsert` antes de montar o `PayloadFrame`. Cargas maiores devem ser quebradas em lotes.                                                                                                                                            |
| `AGENT_SQL_BULK_INSERT_MAX_JSON_BYTES`               | `10485760`  | Teto UTF-8 do JSON serializado de `params` em `sql.bulkInsert`; protege memoria do hub antes de encaminhar ao agente.                                                                                                                                                         |
| `SOCKET_AUDIT_BATCH_MAX`                             | `48`        | Eventos por transação na auditoria Socket (1 = um INSERT por evento).                                                                                                                                                                                                        |
| `SOCKET_AUDIT_BATCH_FLUSH_MS`                        | `200`       | Intervalo máximo antes de flush do lote de auditoria.                                                                                                                                                                                                                        |
| `SOCKET_AUDIT_MAX_QUEUE`                             | `50000`     | Cap de eventos em memória antes de começar a descartar os mais antigos. Evita crescimento sem limite quando a BD atrasa.                                                                                                                                                      |
| `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT`            | ver tabela _production_; senão `100` | Percentagem de eventos de auditoria em `relay:rpc.chunk` persistidos.                                                                                                                                                                                             |

**Relay multi-replica:** conversas, rotas pendentes e lookups `findAgentBridgeSocketById` / `findConsumerSocketById` sao **por processo**. Mesmo com `SOCKET_IO_REDIS_ADAPTER_URL`, o dispatch relay exige que consumer e agent estejam na mesma instancia (sticky sessions). Detalhes em `docs/socket/socket_relay_protocol.md` (secao «Modelo multi-replica»).

### Byte caps do buffer relay

`SOCKET_RELAY_MAX_BUFFERED_BYTES_PER_REQUEST` (default `16777216`) e
`SOCKET_RELAY_MAX_TOTAL_BUFFERED_BYTES` (default `268435456`) limitam os bytes
UTF-8 estimados mantidos nos buffers de stream relay. Eles complementam os
limites por quantidade de chunks e abortam o stream relay com
`relay:rpc.complete` terminal quando excedidos.

## Guards e limites do consumer socket

| Variável                                                       | Defeito                                     | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS`                          | `0`                                         | Quando `> 0`, o guard de conta activa nos sockets (`assertJwtUserAccountActive`) pode **omitir** a query à BD no mesmo socket até expirar o TTL (útil em consumidores com muitos eventos). `block`/`unblock` pode atrasar-se até esse intervalo. `0` = sempre consultar a BD (comportamento por defeito). Métricas: `plug_socket_consumers_guard_db_`.                                                                                                                                                                                                           |
| `SOCKET_CONSUMER_AGENT_ACCESS_SNAPSHOT_TTL_MS`                 | `0`                                         | Quando `> 0`, o guard `assertConsumerSocketAgentAccess` pode **omitir** `assertPrincipalAccess` (e joins redundantes em `consumer:client-agent:`_) no mesmo socket+agente até expirar o TTL. Revogações podem atrasar-se até esse intervalo;_ `0` _= sempre revalidar (comportamento por defeito). O snapshot e **invalidado** quando o reconcile remove a room_ `consumer:client-agent:`, em grant/revoke de acesso (`invalidateApprovedAgentIdsCache`) e, em multi-replica, via `fetchSockets` na room de profile do agente (`invalidateAgentAccessSnapshot`). |
| `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`                      | `32`                                        | Teto de operações assíncronas simultâneas por socket consumer (`agents:command`, `relay:conversation.start`, `relay:rpc.request`, `agents:stream_pull`, `relay:rpc.stream.pull`). Quando `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` é `0`, `socket:event.publish` **partilha** este teto. `0` desativa o gate partilhado.                                                                                                                                                                                                                             |
| `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET`          | `0`                                         | Quando `> 0`, `socket:event.publish` usa um contador **próprio** (não conta para o teto acima), evitando que relay/comandos monopolizem publicações custom ou o inverso. `0` = publicação custom partilha `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`. Quando **ambos** `> 0`, os dois contadores são independentes: no pior caso o socket pode ter até **soma** dos dois valores de operações em voo (relay/comandos + publicações custom).                                                                                                                       |
| `SOCKET_RATE_LIMIT_REDIS_URL`                                  | _(vazio)_                                   | Redis opcional para rate limits Socket (`agents:command`, `agents:stream_pull`, `relay:`, `agent:register`). Vazio = memoria por processo. Quando configurado, falha de Redis e fail-open com fallback local; sticky sessions continuam obrigatorias para estado Socket.                                                                                                                                                                                                                                                                                         |
| `SOCKET_IO_REDIS_ADAPTER_URL`                                  | _(vazio)_                                   | Redis adapter opcional do Socket.IO para rooms/pubsub entre replicas. Quando configurado, broadcasts de rooms (`client:custom.`, rooms de client/principal etc.) atravessam replicas. Falha de conexao inicial em `NODE_ENV=production` **ou** com `SOCKET_IO_REDIS_ADAPTER_REQUIRED=true` aborta o bootstrap; falhas runtime ou em dev/test (sem a flag) caem para adapter em memoria na instancia e disparam reconnect com backoff. Sticky sessions ainda sao recomendadas para relay, pending requests e presenca de agentes.                                 |
| `SOCKET_IO_REDIS_ADAPTER_REQUIRED`                             | `false`                                     | Quando `true`, falha de conexao inicial ao Redis adapter aborta o bootstrap sempre que `SOCKET_IO_REDIS_ADAPTER_URL` estiver definido, mesmo fora de producao (util em staging multi-replica).                                                                                                                                                                                                                                                                                                                                                                   |
| `SOCKET_IO_REDIS_ADAPTER_KEY`                                  | `socket.io`                                 | Prefixo Redis pub/sub do `@socket.io/redis-adapter`. Use chave distinta quando partilhar Redis com outros clusters Socket.IO.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SOCKET_IO_REDIS_ADAPTER_REQUESTS_TIMEOUT_MS`                  | `5000`                                      | Timeout (ms) de pedidos cross-node do adapter (`fetchSockets`, `allRooms`, etc.).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SOCKET_IO_REDIS_ADAPTER_PUBLISH_ON_SPECIFIC_RESPONSE_CHANNEL` | `false`                                     | Quando `true`, respostas do adapter publicam num canal Redis especifico do no (comportamento futuro recomendado pela biblioteca).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SOCKET_IO_REDIS_ADAPTER_CONNECT_TIMEOUT_MS`                   | `5000`                                      | Timeout (ms) de ligacao TCP do cliente `node-redis` usado pelo adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS`                    | `1000`                                      | Atraso base (ms) do backoff exponencial de reconnect do hub apos falha runtime do adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SOCKET_IO_REDIS_ADAPTER_RECONNECT_MAX_MS`                     | `30000`                                     | Atraso maximo (ms) do backoff de reconnect do adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `AGENT_HUB_PRESENCE_REDIS_URL`                                 | _(vazio →_ `SOCKET_IO_REDIS_ADAPTER_URL`_)_ | Redis para presenca distribuida do agente e forward de `POST /api/v1/agents/commands` entre replicas. Vazio e adapter vazio = desactivado (registry local apenas).                                                                                                                                                                                                                                                                                                                                                                                               |
| `AGENT_HUB_PRESENCE_ENABLED`                                   | `true`                                      | `false` desactiva presenca/forward mesmo com URL Redis configurada.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `AGENT_HUB_PRESENCE_TTL_MS`                                    | `120000`                                    | TTL renovado em `agent:register`, heartbeat/ready e touch de protocolo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AGENT_HUB_BRIDGE_FORWARD_TIMEOUT_MS`                          | `15000`                                     | Timeout aguardando resposta da replica dona do socket durante forward.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SOCKET_RELAY_AGENT_MAX_INFLIGHT`                              | `32`                                        | Requests `relay:rpc.request` simultaneas por agente antes de enfileirar. `0` desativa o gate por agente.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SOCKET_RELAY_AGENT_MAX_QUEUE`                                 | `64`                                        | Profundidade da fila FIFO por agente para relay. `0` = fila ilimitada (ainda sujeita a timeout).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SOCKET_RELAY_AGENT_QUEUE_WAIT_MS`                             | `200`                                       | Tempo maximo aguardando slot na fila por agente; rejeita com `SERVICE_UNAVAILABLE` e `retryAfterMs` quando estoura.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SOCKET_AGENTS_STREAM_PULL_RATE_LIMIT_MAX_CREDITS`             | `0`                                         | Orcamento por janela para creditos de `agents:stream_pull` legacy. `0` preserva comportamento anterior sem limite por creditos; quando ativo, a resposta inclui `rateLimit`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `SOCKET_AGENTS_COMMAND_RATE_LIMIT_WEIGHTED_COSTS`              | `false`                                     | Quando `true`, `agents:command` consome creditos por trabalho aproximado (`command[]` soma itens; `sql.executeBatch` soma comandos internos). `false` preserva o comportamento historico de um evento = um credito.                                                                                                                                                                                                                                                                                                                                              |
| `SOCKET_CUSTOM_EVENT_MAX_SUBSCRIPTIONS_PER_SOCKET`             | `128`                                       | Maximo de eventos `client:custom.*` que um socket `/consumers` pode assinar ao mesmo tempo. `0` = ilimitado.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SOCKET_CUSTOM_EVENT_RECIPIENT_COUNT_CACHE_TTL_MS`             | `0`                                         | Cache curto (ms) da contagem de recipients por room em `countSocketsInRoom` **sem** `captureSockets`. `0` = desligado (sempre fresco). Opt-in sob rajadas de `socket:event.publish` / REST publish para reduzir `fetchSockets()` cluster-wide; a contagem pode atrasar ate ao TTL.                                                                                                                                                                                                                                                                             |
| `SOCKET_CUSTOM_EVENT_RECIPIENT_COUNT_CACHE_MAX_SIZE`           | `2048`                                      | Maximo de rooms no cache de recipient count.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SOCKET_CUSTOM_EVENT_SUBSCRIPTION_RATE_LIMIT_WINDOW_MS`        | `60000`                                     | Janela do rate limit local para controles `socket:event.subscribe` / `socket:event.unsubscribe` por socket.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SOCKET_CUSTOM_EVENT_SUBSCRIPTION_RATE_LIMIT_MAX`              | `240`                                       | Quantidade maxima de subscribe/unsubscribe validos por socket dentro da janela. `0` desativa.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION`        | `1024`                                      | Cap FIFO por conversa para o mapa de idempotência relay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES`                   | `100000`                                    | Cap FIFO global para o mapa de idempotência relay. `0` desativa o teto global.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Inflight gate por socket (`SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`)

O contador é **por ligação** `/consumers` e **local ao processo** (não coordena entre réplicas). Cada handler assíncrono reserva um slot com `tryAcquireSocketInflightSlot` e liberta-o no `finally`; acima do teto o hub responde `RATE_LIMITED` imediatamente, sem entrar na bridge — distinto de `SOCKET_RELAY_AGENT_MAX_INFLIGHT`, que limita requests relay **por agente** alvo.

**Ajuste operacional:**

- **Defeito (**`32`**)**: paralelismo moderado num único consumidor (poucas conversas/comandos em voo).
- **Aumentar** (ex.: `128`–`512`) quando um dashboard ou integração dispara muitos `agents:command`, `agents:stream_pull` ou `relay:`* em paralelo na **mesma** sessão Socket e observa `RATE_LIMITED` por inflight (não confundir com `429` da janela de rate limit relay). Preset comentado em `.env.example` (*Multi-agent dashboard).
- `0`: desativa o gate partilhado (sem backpressure por inflight neste eixo); use só com consciência de carga e memória.
- **Publicações custom**: se `socket:event.publish` competir com relay/comandos, defina `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` > 0 para um contador dedicado; com **ambos** > 0 o máximo em voo pode ser a **soma** dos dois tetos.

Ver também `docs/socket/socket_relay_protocol.md` (_Separadamente do orçamento de relay…_).

## REST -> Socket pub/sub customizado

| Variavel                                               | Defeito                                                | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`               | `60000`                                                | Janela do rate limit de `POST /api/v1/client/me/socket-events` (por IP/JWT conforme middleware).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `REST_SOCKET_EVENT_RATE_LIMIT_MAX`                     | `120`                                                  | Publicacoes REST permitidas por janela. `0` desativa o limitador HTTP desta rota. Com `skipFailedRequests` + `requestWasSuccessful` (`statusCode < 500`), respostas **5xx** ao fim do pedido **decrementam** o hit (alinhado ao refund do rate limit de `socket:event.publish` em falhas transitorias); **4xx** (validacao, `409`, `413`, etc.) **mantem** o hit.                                                                                                                                                                                                                     |
| `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_WINDOW_MS`     | _(espelha_ `REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`_)_ | Quando definida, janela (ms) **apenas** para `socket:event.publish` (balde independente do Express e do contador REST).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_MAX`           | _(espelha_ `REST_SOCKET_EVENT_RATE_LIMIT_MAX`_)_       | Quando definida, maximo de `socket:event.publish` por janela por JWT `sub` de `Client`. `0` desativa o limitador Socket deste evento.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `REST_SOCKET_EVENT_MAX_FILES`                          | `5`                                                    | Numero maximo de anexos multipart inline (`files`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `REST_SOCKET_EVENT_FILE_MAX_BYTES`                     | `524288`                                               | Tamanho maximo por arquivo inline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `REST_SOCKET_EVENT_TOTAL_FILES_MAX_BYTES`              | `2097152`                                              | Soma maxima dos anexos inline por publicacao.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES`             | `524288`                                               | Teto UTF-8 do `payload` JSON antes de empacotar em `PayloadFrame`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `REST_SOCKET_EVENT_MAX_RECIPIENTS`                     | `0`                                                    | Teto opcional de fan-out por publicacao. `0` = ilimitado; quando estoura, retorna `503`. Sem Redis adapter a contagem usa o mapa local de rooms; com `SOCKET_IO_REDIS_ADAPTER_URL`, a contagem usa `fetchSockets()` para cobrir replicas remotas antes de emitir. Em producao com rooms grandes defina um teto > 0 para shedding previsivel.                                                                                                                                                                                                                                          |
| `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS`              | `2000`                                                 | Valor (ms) de `error.details.retry_after_ms` nesse `503` (REST e `socket:event.publish`); **não** é a janela do rate limit de publicação (`REST_SOCKET_EVENT_RATE_LIMIT_WINDOW_MS`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| `REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS`                 | `300000`                                               | Janela em memoria para deduplicar publicacoes com `Idempotency-Key` (REST) ou `idempotencyKey` no corpo (`socket:event.publish`). `0` **desativa o armazenamento**: a chave ainda pode ser validada em formato, mas **nao** ha replay guardado (cada pedido emite de novo). Com TTL > 0, pedidos **concorrentes** com a mesma chave no **mesmo processo** sao serializados para evitar dupla emissao antes da escrita no cache. **Sequencial** (um apos o outro) com TTL `0`: o segundo pedido com a mesma chave **pode voltar a emitir** — use TTL > 0 para replay entre tentativas. |
| `REST_SOCKET_EVENT_IDEMPOTENCY_MAX_ENTRIES`            | `10000`                                                | Maximo de respostas idempotentes retidas por processo. Quando o mapa enche, entradas sao expulsas pela **ordem de insercao** (primeira chave do `Map`) ate haver espaco — nao e eviction por `expiresAtMs` mais antigo; o prune por TTL continua a correr em escritas.                                                                                                                                                                                                                                                                                                                |
| `REST_SOCKET_EVENT_IDEMPOTENCY_SERIALIZATION_MAX_KEYS` | `0`                                                    | Maximo de cadeias de serializacao **distintas** `(clientId, idempotencyKey)` em voo no processo; `0` = ilimitado. Acima do teto, novas chaves distintas recebem `503` ate concluirem publicacoes em curso; `error.details.retry_after_ms` segue `REST_SOCKET_EVENT_FANOUT_RETRY_AFTER_MS` (como no `503` de fan-out). Nao coordena entre replicas.                                                                                                                                                                                                                                    |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL`              | _(vazio)_                                              | Redis opcional para replay/conflito de `Idempotency-Key` entre replicas. Quando vazio, segue local por processo. Use junto de `SOCKET_IO_REDIS_ADAPTER_URL` em multi-replica.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_TTL_MS`      | `5000`                                                 | TTL do lock `SET NX` que protege a primeira emissao de uma chave idempotente entre replicas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_WAIT_MS`          | `750`                                                  | Quanto outra replica espera pela resposta idempotente antes de retornar `503` retryable. `0` = fail-fast.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `REST_SOCKET_EVENT_HTTP_JSON_BODY_LIMIT`               | _(derivado)_                                           | Limite do `express.json` **apenas** para `POST /api/v1/client/me/socket-events` com `Content-Type: application/json`. Vazio: calcula ~110% do pior caso UTF-8 (payload + anexos inline em base64) a partir de `REST_SOCKET_EVENT_`. O `REQUEST_BODY_LIMIT` global continua baixo para as demais rotas.                                                                                                                                                                                                                                                                                |

O hub tambem calcula `socketEventPublishRawJsonMaxBytes` (sem variavel de ambiente dedicada): e o teto em bytes UTF-8 para o JSON bruto de `socket:event.publish` antes do Zod, derivado de `REST_SOCKET_EVENT_PAYLOAD_JSON_MAX_BYTES` e dos tetos de anexos REST, **limitado por** `SOCKET_IO_MAX_HTTP_BUFFER_BYTES` (pacote Engine.IO). Se exceder o buffer, o hub regista `WARN` no arranque — mensagens maiores que o buffer podem ser cortadas antes do handler.

**Redis (rate limits, chaves ilustrativas):**

| Canal                                      | Prefixo / scope                                               | Sufixo de identidade (Client JWT `sub`)          |
| ------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------ |
| HTTP `POST .../socket-events`              | `plug_rl:client_socket_event_publish:` (`express-rate-limit`) | `client:<sub>` (ou `client:anonymous` sem `sub`) |
| Socket `socket:event.publish`              | `plug_socket_rl:client_socket_event_publish:`                 | `client:<sub>`                                   |
| Idempotencia distribuida `client:custom.*` | `plug_socket_event_idem:` / `plug_socket_event_idem_lock:`    | SHA-256 de `(clientId, idempotencyKey)`          |

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

| Endpoint                                                                  | Comportamento                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `GET /api/v1/client/me/agents/{agentId}/client-token`                     | Retorna o token (ou `null`). 403 sem acesso aprovado.              |
| `PUT /api/v1/client/me/agents/{agentId}/client-token`                     | Body `{ clientToken: string                                        | null }`. String vazia vira `null`. Tamanho ≤ 512. Não cria a linha de acesso. |
| `GET /api/v1/client/me/agents` e `GET /api/v1/client/me/agents/{agentId}` | Cada agente carrega `hasClientToken: boolean` (sem expor o valor). |

Não há limite de rate específico para `PUT client-token` além do
`globalRateLimit` (`/api/v1` 300 req / 15 min) — pondere subir um limiter
dedicado se for usado em UI com edição contínua.

## REST: CORS, request id, rate limits

| Variável / Comportamento                                                               | Defeito                               | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGIN`                                                                          | `*` em dev; **rejeitado** em produção | Aceita uma origem única **ou** lista separada por vírgula (`https://a,https://b`). A mesma política parseada é reutilizada por **HTTP e Socket.IO**; quando há lista de origens específicas, ambos validam o `Origin` e habilitam credentials. `*` desativa credentials.                                                                                                                                                                                |
| `HTTP_TRUST_PROXY`                                                                     | `true` em produção                    | `1` hop. Necessário para `req.ip` e rate limits corretos atrás de Nginx ou outro reverse proxy.                                                                                                                                                                                                                                                                                                                                                         |
| `DATABASE_URL`                                                                         | _(obrigatório)_                       | URL Postgres (Prisma). Em carga alta, usar `connection_limit` e `pool_timeout` na query string conforme o plano da base e réplicas do hub (ex. `?connection_limit=10&pool_timeout=20`). Os emails em `users.email` e `clients.email` usam o tipo `citext` (unicidade insensível a maiúsculas); a migração `20260512190000_citext_user_client_email` cria a extensão `citext` — em Postgres gerido, ative-a no projeto antes de `prisma migrate deploy`. |
| `DATABASE_TRANSACTION_RETRY_MAX_ATTEMPTS` / `DATABASE_TRANSACTION_RETRY_BASE_DELAY_MS` | `3` / `25`                            | Retry curto para conflitos transientes em transações Prisma críticas (`40001`, `40P01`, `P2034`). `1` desativa retry.                                                                                                                                                                                                                                                                                                                                   |
| Header `x-request-id`                                                                  | **sanitizado**                        | Aceito apenas se casar `^[A-Za-z0-9._-]{1,128}$`; caso contrário é substituído por `crypto.randomUUID()` para evitar log injection e header splitting. Sempre volta na resposta como `x-request-id`.                                                                                                                                                                                                                                                    |
| `loginRateLimit`                                                                       | `200` requests / `5m` (padrão)        | Endpoints de **login com senha**: `/api/v1/auth/login`, `/api/v1/auth/agent-login`, `/api/v1/client-auth/login` (e aliases `/auth/login`, `/auth/agent-login`). Variáveis: `REST_LOGIN_RATE_LIMIT_`.                                                                                                                                                                                                                                                    |
| `credentialAuthRateLimit`                                                              | `25` requests / `15m`                 | Endpoints **com senha ou revogação sensível** (exceto login e refresh): `register`, `logout`, `registration/`, `/api/v1/client-auth/logout`, equivalentes, `/client-auth/password-recovery/reset` e `/client-access/{review,status,approve,reject}`. **Não** inclui `POST .../login` nem `POST .../refresh`.                                                                                                                                            |
| `REST_TOKEN_REFRESH_RATE_LIMIT_*`                                                      | `400` requests / `15m` (padrão)       | Aplicado só a `POST /auth/refresh` e `POST /client-auth/refresh` (e aliases `/api/v1/...`), para permitir rotação em massa de access tokens após quedas (muitos agentes no mesmo IP).                                                                                                                                                                                                                                                                   |
| `REST_RATE_LIMIT_REDIS_URL`                                                            | _(vazio)_                             | Opcional. URL Redis (`redis://host:6379`) para estado partilhado dos limitadores HTTP entre réplicas; vazio mantém store em memória por processo. Sem palavra-passe na URL = Redis sem `requirepass` (reforçar rede/firewall). Fail-open com circuito temporário em falha runtime. Métricas: `plug_rest_http_rate_limit_redis_` em `/metrics`.                                                                                                          |

**Checklist plug_agente / UI (reconexão):** refresh proativo do access JWT antes do `exp`; em falha de handshake `/agents` com 401, chamar `POST /auth/refresh` e reconectar; ao receber `app:error` com `code: SERVER_SHUTDOWN`, backoff com jitter antes de retentar; tratar `agent:register_error.reason` (`transient_failure` / `rate_limited` vs reconexão forçada) conforme `[agent_register_error.ts](../src/presentation/socket/hub/handshake/agent_register_error.ts)`.

| Cookie `refresh_token` / `client_refresh_token` | `HttpOnly`, `Secure` em prod, `SameSite=Strict`, `Path=/`, `Max-Age` = `JWT_REFRESH_EXPIRES_IN` correspondente | `Max-Age` usa o mesmo env do JWT para evitar cookie órfão após revogação. Logout sempre limpa o cookie; change-password de `User` e `Client` também limpa para refletir invalidação de sessão. |
| `/metrics` (root e `/api/v1/metrics`) | exige `requireAuthAndActiveAccount` + role `admin` | Restrito a admin. Use `HUB_INSTANCE_ID` para distinguir réplicas em scrape. |
| `/health/ready` | probe `SELECT 1` no Postgres com timeout `1500 ms` | Retorna `503` + `status: "degraded"` quando o probe falha; `200` caso contrário. Em `NODE_ENV=test` o probe é omitido. `/health/live` continua sempre `200`. |
| `/uploads` (estático) | `etag: true`, `maxAge: 7d`, `immutable`, `dotfiles: deny`, `fallthrough: false`, `index: false` | Endurece o `express.static` para evitar listagem, dotfiles e relisten ao 404. Ver **Política pública de thumbnails** abaixo. |
| `express.urlencoded` | `extended: false` | Usa o parser `querystring` nativo; só os formulários HTML de aprovação dependem dele e carregam `{ token, reason? }`. |
| Upload de thumbnail | multer + validação magic-bytes via `sharp().metadata()` | Allowlist: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. `MulterError` (size limit e afins) é convertido para `400 BAD_REQUEST`, não `500`. |

### Política pública de thumbnails (`/uploads`)

O mount estático `/uploads` serve ficheiros do diretório `UPLOADS_DIR` **sem autenticação**. Isto é intencional: as URLs de thumbnail de client (`UPLOADS_PUBLIC_BASE_URL`, tipicamente `{APP_BASE_URL}/uploads/client-thumbnails/...`) são referenciadas em respostas JSON e carregadas por browsers ou apps Colmeia como imagens públicas.

Implicações de segurança (comportamento actual, sem breaking change):

- **Confidencialidade**: qualquer pessoa com a URL completa pode obter o ficheiro; os nomes incluem UUID + timestamp + sufixo aleatório (dificulta adivinhação, mas não substitui controlo de acesso).
- **Escopo**: apenas ficheiros gravados pelo hub sob `client-thumbnails/` (e outros segmentos futuros documentados) entram neste volume; `dotfiles: deny` e recusa de paths fora de `UPLOADS_DIR` no adapter de storage impedem traversal.
- **Cache**: `maxAge: 7d` + `immutable` — após substituir uma thumbnail, a URL muda; clientes não devem assumir invalidação imediata da URL antiga.
- **Operação**: em produção, `UPLOADS_DIR` deve ser volume persistente; reverse proxy pode cachear `/uploads/` como estático público.

Upload continua protegido: `POST /api/v1/client-auth/me/thumbnail` exige JWT de `Client`, rate limit dedicado e validação de tipo/tamanho.

### CORS sem header `Origin` e cookies

Com `CORS_ORIGIN` listando origens específicas (não `*`), `buildCorsOptions` define `credentials: true` e valida o header `Origin` contra a lista.

Pedidos **sem** header `Origin` (ou com `Origin: null`, ex.: iframes sandbox, alguns in-app browsers) são **aceites** pelo middleware CORS — reflectem como same-origin do ponto de vista do pacote `cors`. Isto cobre:

- **curl**, **Postman**, health probes e outros clientes não-browser;
- scripts server-side com refresh token no body/header (transporte documentado para non-browser).

Para endpoints que definem cookies (`refresh_token`, `client_refresh_token`):

- Browsers enviam `Origin` em cross-site XHR/fetch; origens não listadas recebem erro CORS antes de chegar ao handler.
- Pedidos same-origin (UI servida pelo mesmo host da API) podem omitir `Origin`; cookies `SameSite=Strict` continuam restritos ao site da API.
- Com `CORS_ORIGIN=*` (só dev/test), `credentials: false` — cookies **não** são expostos cross-origin; use lista explícita em staging/produção quando a UI estiver noutro host.

Não confundir CORS com CSRF: métodos inseguros que aceitam cookies mantêm `SameSite=Strict` e validação de conta activa; formulários HTML de aprovação usam tokens opacos, não cookies de sessão.

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

## Socket.IO ([Engine.IO](http://Engine.IO))

| Variável                                                   | Defeito                                            | Notas                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `SOCKET_IO_SERVE_CLIENT`                                   | `false`                                            | Não servir o bundle `socket.io` a partir deste servidor (hub API).    |
| `SOCKET_IO_HTTP_COMPRESSION`                               | ver tabela _production_; senão `true`              | Compressão nas respostas **polling**; `false` se só usas `websocket`. |
| `SOCKET_IO_PING_INTERVAL_MS` / `SOCKET_IO_PING_TIMEOUT_MS` | _(omitido)_                                        | Heartbeat Engine.IO (defaults 25000 / 20000 ms).                      |
| `SOCKET_IO_UPGRADE_TIMEOUT_MS`                             | _(omitido)_                                        | Timeout de upgrade polling→WebSocket (default Engine.IO 10000 ms).    |
| `SOCKET_IO_TRANSPORTS`                                     | ver tabela _production_; senão `websocket,polling` | Produção sem variável: só `websocket` (menos CPU/handshake).          |
| `SOCKET_IO_PER_MESSAGE_DEFLATE`                            | `false`                                            | Evita deflate WS duplicado com `PayloadFrame`.                        |
| `SOCKET_IO_MAX_HTTP_BUFFER_BYTES`                          | `10485760`                                         | Teto alinhado a frames de 10 MiB.                                     |

### Redis adapter (`@socket.io/redis-adapter`)

Requer `SOCKET_IO_REDIS_ADAPTER_URL`. As variaveis abaixo ajustam o adapter e o cliente Redis subjacente; os defaults preservam o comportamento historico do hub e da biblioteca.

| Variável                                                       | Defeito     | Notas                                                                      |
| -------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `SOCKET_IO_REDIS_ADAPTER_KEY`                                  | `socket.io` | Prefixo dos canais Redis pub/sub.                                          |
| `SOCKET_IO_REDIS_ADAPTER_REQUESTS_TIMEOUT_MS`                  | `5000`      | Timeout de pedidos cross-node (`fetchSockets`, contagens distribuidas).    |
| `SOCKET_IO_REDIS_ADAPTER_PUBLISH_ON_SPECIFIC_RESPONSE_CHANNEL` | `false`     | Canal de resposta por no (opt-in; alinha com proximo major da biblioteca). |
| `SOCKET_IO_REDIS_ADAPTER_CONNECT_TIMEOUT_MS`                   | `5000`      | Timeout TCP do `node-redis`.                                               |
| `SOCKET_IO_REDIS_ADAPTER_RECONNECT_BASE_MS`                    | `1000`      | Backoff exponencial apos falha runtime (primeira tentativa).               |
| `SOCKET_IO_REDIS_ADAPTER_RECONNECT_MAX_MS`                     | `30000`     | Teto do backoff de reconnect do hub.                                       |

### Redis envs — convencao de "vazio = desligado"

Todos os modulos Redis seguem a mesma convencao: a env de URL vazia faz o
modulo correr em modo local-only (sem Redis), e nenhuma boot-time error
e' lancada. Quando ha tambem uma flag `_ENABLED`, essa flag domina (mesmo
com a URL preenchida, `*_ENABLED=false` mantem o modulo desligado).

> Para guidance de auth/TLS, ACLs, eviction policies e network isolation, ver
> `[docs/infrastructure/redis_security.md](infrastructure/redis_security.md)`. Para a arquitetura interna dos
> 5 modulos Redis e factories ver
> `[src/infrastructure/redis/README.md](../src/infrastructure/redis/README.md)`.

| Modulo                           | URL env                                   | Flag opcional `_ENABLED`           | Default operacional                |
| -------------------------------- | ----------------------------------------- | ---------------------------------- | ---------------------------------- |
| Adapter Socket.IO (rooms/pubsub) | `SOCKET_IO_REDIS_ADAPTER_URL`             | -                                  | Vazio = adapter em memoria         |
| Rate-limit Socket                | `SOCKET_RATE_LIMIT_REDIS_URL`             | -                                  | Vazio = limites por processo       |
| Rate-limit REST                  | `REST_RATE_LIMIT_REDIS_URL`               | -                                  | Vazio = store memoria por processo |
| Idempotency `client:custom.*`    | `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL` | -                                  | Vazio = idempotency local          |
| Agent event stream (backlog)     | `AGENT_EVENT_STREAM_REDIS_URL`            | `AGENT_EVENT_STREAM_ENABLED=false` | Default off (opt-in)               |

Tuning compartilhado (todos os modulos exceto o adapter Socket.IO, que tem
suas proprias envs `SOCKET_IO_REDIS_ADAPTER_*`):

| Variavel                           | Default | Notas                                                                                                                                                    |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_DEFAULT_CONNECT_TIMEOUT_MS` | `5000`  | `socket.connectTimeout` para todos os clientes nao-adapter.                                                                                              |
| `REDIS_DEFAULT_RECONNECT_BASE_MS`  | `200`   | Base do backoff exponencial capped.                                                                                                                      |
| `REDIS_DEFAULT_RECONNECT_MAX_MS`   | `5000`  | Teto do backoff.                                                                                                                                         |
| `STRICT_REDIS_AUTH`                | `false` | Quando `true` + `NODE_ENV=production`, recusa boot se algum `*_REDIS_URL` usar `redis://` sem senha (use `rediss://` ou `redis://default:<pwd>@host`).   |
| `REDIS_TENANT_ID`                  | vazio   | Multi-tenancy hard via prefixo `{plug}:<tenant>` em todos os 5 modulos. Match `^[A-Za-z0-9_-]{1,32}$`. Ver [ADR-0006](adrs/0006-redis-multi-tenancy.md). |
| `REDIS_OTEL_SPANS_ENABLED`         | `false` | Spans OTel `redis.<module>.<op>` para comandos hot-path. Requer `OTEL_TRACES_ENABLED=true`.                                                              |

> **Sprint P3.1**: o boot dos 4 modulos Redis nao-adapter (`socket_rate_limit`,
> `rest_rate_limit`, `client_socket_event_idempotency`, `agent_event_stream`)
> roda em paralelo via `Promise.all`. Em ambientes degradados onde uma URL
> esta unreachable, o tempo total de boot passa de `Σ(initᵢ)` para
> `max(initᵢ)`. O adapter Socket.IO continua sequencial porque depende do
> `io` instance criado em `createSocketServer`. Ver
> `[docs/adrs/0007-parallel-redis-init.md](adrs/0007-parallel-redis-init.md)`.

### Streams backlog (`AGENT_EVENT_STREAM_*`)

Quando `AGENT_EVENT_STREAM_ENABLED=true`, o publish hub escreve cada frame
em um stream Redis por recipient, permitindo entrega at-least-once a
subscribers que reconectam em outra replica. Uma RTT pipelined cobre toda
a fan-out (`MULTI/EXEC` — Sprint P1).

| Variavel                                  | Default    | Notas                                                                       |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `AGENT_EVENT_STREAM_REDIS_URL`            | vazio      | Vazio = backlog desabilitado (gating effective do stream).                  |
| `AGENT_EVENT_STREAM_ENABLED`              | `false`    | Liga a feature mesmo com URL configurada.                                   |
| `AGENT_EVENT_STREAM_MAX_LEN`              | `1000`     | `XADD MAXLEN ~` por recipient.                                              |
| `AGENT_EVENT_STREAM_TTL_MS`               | `86400000` | `PEXPIRE` aplicado por recipient (24h default). `0` desliga TTL.            |
| `AGENT_EVENT_STREAM_BACKLOG_MAX_ENTRIES`  | `500`      | `COUNT` no `XREAD`/`XREADGROUP` por drain.                                  |
| `AGENT_EVENT_STREAM_AGENT_ALLOWLIST`      | vazio      | CSV de recipient principal ids. Vazio = todos. Util para rollout em staged. |
| `AGENT_EVENT_STREAM_DRAIN_ACK_TIMEOUT_MS` | `1000`     | Timeout do ack por subscriber durante drain.                                |
| `AGENT_EVENT_STREAM_USE_CONSUMER_GROUPS`  | `false`    | `XREADGROUP`/`XACK` em vez de `XREAD`/`XDEL`. Coordena cross-replica.       |
| `AGENT_EVENT_STREAM_CONSUMER_GROUP`       | `plug_hub` | Nome do consumer group.                                                     |
| `AGENT_EVENT_STREAM_APPEND_MODE`          | `await`    | Backpressure: `await` (bloqueia), `timeout` (race), `fire_and_forget`.      |
| `AGENT_EVENT_STREAM_APPEND_TIMEOUT_MS`    | `50`       | Timeout do batch quando `APPEND_MODE=timeout`.                              |

### Idempotency `client:custom.*` (`REST_SOCKET_EVENT_IDEMPOTENCY_*`)

| Variavel                                              | Default | Notas                                                                           |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL`             | vazio   | Vazio = idempotency local. Ver topo da secao para semantica de fan-out.         |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_READ_URL`        | vazio   | Sprint 11 — read-replica para `getEntry`. Writes no primary.                    |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_TTL_MS`     | `5000`  | TTL do lock distribuido.                                                        |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_WAIT_MS`         | `750`   | Wait maximo apos perder o lock antes de devolver `503`.                         |
| `REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_LOCK_RENEWAL_MS` | `0`     | `0` = sem watchdog. >0 = renova lock a cada N ms (recomendado `LOCK_TTL_MS/3`). |

## Generous profile — perfil de capacidade

O perfil "generous" prioriza throughput maximo aceitando custos previsiveis de
RAM/CPU/conexoes. Aplicado em `[.env](../.env)` por default; defaults do schema
em `[env.ts](../src/shared/config/env.ts)` ficam intencionalmente conservadores
para single-replica / dev. Trade-offs documentados em
[CHANGELOG.md](../CHANGELOG.md) (entrada `Generous profile`).

| Area                                | Generous (`.env` ativo)               | Default schema (`env.ts`)      | Por que                                                                             |
| ----------------------------------- | ------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| Postgres pool (no `DATABASE_URL`)   | `connection_limit=40&pool_timeout=45` | `15` / `20`                    | 256 inflight relay + 256 REST + 512 async/socket + audit batches concorrem.         |
| Queue waits relay/REST agent        | `2000` ms                             | `200` ms                       | Bursts esperam 2 s antes do `503`; reduz amplificacao de retries.                   |
| Outbound overload shedding          | `BACKLOG=0`, `P95_MS=0` (off)         | `BACKLOG=200`, `P95_MS=250`    | Buffers (16 MiB / 256 MiB) e queue caps ja absorvem; shedding antecipava rejeicoes. |
| Per-conversation pending requests   | `256`                                 | `32`                           | Alinha com `_PER_CONSUMER=1024`.                                                    |
| Per-consumer max inflight (socket)  | `512`                                 | `32`                           | ~60 agentes em paralelo por consumer.                                               |
| Custom publish max inflight         | `512`                                 | `128`                          | Empata com `_CONSUMER_MAX_INFLIGHT_PER_SOCKET`.                                     |
| JWT verify cache                    | `120s` TTL, `20000` entries           | `30s`, `2000`                  | HMAC-SHA512 caro; revalidacao do `exp` em hit garante seguranca.                    |
| Profile sync concurrency            | `32`                                  | `8`                            | Reconnect storm de ~60 agentes converge mais rapido.                                |
| Audit batch / queue                 | `192` / `200000`                      | `1` / `50000` (env.ts default) | Menos round-trips Prisma; queue absorve stalls.                                     |
| Email outbox poll / batch / workers | `1000` ms / `100` rows / `8`          | `3000` / `25` / `4`            | Drena bursts de aprovacao mais rapido.                                              |
| Profile recipients cache            | `30s` TTL, `15000` entries            | `15s`, `2500`                  | Reduz pressao DB; bounded por revoke (TTL).                                         |
| Self profile rate limit             | `0` (unlimited)                       | `20` / minuto                  | Self-service nao precisa de proteao acima da auth.                                  |
| Swagger em prod                     | `false`                               | `true`                         | Construir spec on-demand consome CPU; habilitar so em staging/dev.                  |
| HTTP RED histogram buckets (s)      | `[…, 5, 10, 15, 30]`                  | `[…, 5, 10]`                   | Tail latency relay (timeout 15 s) cabe em bucket nomeado.                           |
| Stream batch_size buckets           | `[…, 1000, 2000, 5000]`               | `[…, 1000]`                    | Cobre fan-out de rooms grandes apos P1 pipelined.                                   |

### Como rebaixar para um perfil conservador

Para single-replica / staging onde memoria e conexoes Postgres sao escassas,
sobrescreva no `.env`:

```bash
# Postgres
DATABASE_URL="...?connection_limit=15&pool_timeout=20"

# Queue / overload
SOCKET_RELAY_AGENT_QUEUE_WAIT_MS=200
SOCKET_REST_AGENT_QUEUE_WAIT_MS=200
SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG=200
SOCKET_RELAY_OUTBOUND_OVERLOAD_P95_MS=250

# Inflight
SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET=32
SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET=128
SOCKET_RELAY_MAX_PENDING_REQUESTS_PER_CONVERSATION=32

# Caches / batches
JWT_VERIFY_CACHE_TTL_MS=30000
JWT_VERIFY_CACHE_MAX_SIZE=2000
SOCKET_AUDIT_BATCH_MAX=64
SOCKET_AGENT_PROFILE_SYNC_MAX_CONCURRENT=8
REGISTRATION_EMAIL_OUTBOX_WORKER_CONCURRENCY=4
```

### Sinais para revisitar o perfil generoso

- `prisma_pool_timeout_total` cresce sustentadamente — subir `connection_limit` ou `max_connections` do Postgres.
- `plug_socket_relay_dispatch_queue_wait_timeout_rejected_total` > 0 com `_QUEUE_WAIT_MS=2000` — capacidade real do agente esgotada (nao adianta abrir mais).
- `plug_socket_audit_drops_total` > 0 com `MAX_QUEUE=200000` — Postgres muito atras; investigar locks/IO antes de abrir mais.
- `plug_jwt_verify_cache_evictions_total` cresce — subir `MAX_SIZE` para reduzir thrashing.
- `process_resident_memory_bytes` proximo do limite do container — recuar caches.

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

Toda rejeicao sai pelo evento dedicado `agent:register_error` em **JSON
puro** (NAO `PayloadFrame`) com `{ code, reason, message, details? }`. Tabela
completa de `reason` em `docs/api/api_rest_bridge.md` -> _Falhas de_ `agent:register` _ate o
ownership ser criado_ e `docs/plug_agente/migracao_plug_agente_namespaces.md`. Politica de
sessao: `SOCKET_AGENT_SESSION_POLICY` e (opcional) `SOCKET_AGENT_REGISTER_RATE_LIMIT_*`
na tabela de socket acima.

**Varias instancias do hub:** o registo canónico por `agentId` e os limiters em memória (`SOCKET_AGENT_REGISTER_`, cache de bind) aplicam-se **por processo**. Com varias réplicas à frente do mesmo load balancer, dois agentes com o mesmo ID podem ficar ligados a hubs diferentes salvo **afinidade de sessão** (sticky) ao mesmo processo ou outro mecanismo distribuído. Ver `docs/infrastructure/nginx_production.md` (sticky Socket.IO), `HUB_INSTANCE_ID` / header `X-Hub-Instance-Id`, e `docs/studies/scaling_and_roadmap.md`.

## Ownership de agentes

O ownership oficial do agente nasce em `agent:register`, depois de um `agent-login` válido. Quando o registo traz `profile`, `profile_version` e `profile_updated_at`, o hub persiste esse snapshot versionado e evita o RPC extra. Agentes legados ou registos sem snapshot completo continuam caindo para `agent.getProfile`, chamado com `include_diagnostics=false` para manter o sync barato. O resultado RPC pode incluir `profile_version` (contador monotónico no servidor); o hub usa-o para ordenar o _pull sync_ e detetar divergência quando a versão coincide mas o conteúdo do perfil não bate com o catálogo. Não existem mais variáveis de ambiente nem rate limits dedicados ao antigo fluxo HTTP de self-service bind em `/api/v1/me/agents`, e o catálogo também não aceita mais criação/edição manual por HTTP; por gestão administrativa, apenas a desativação permanece exposta. Atualização self-service pelo próprio agente (fora do registo) está em `PATCH /api/v1/agents/{agentId}/profile`, documentada no OpenAPI (`/docs`, `/docs.json`), e também em `agent:profile.update` no namespace `/agents`.

## Auto-update diagnostics do agente (`AGENT_AUTO_UPDATE_DIAGNOSTICS_*`)

Feature opt-in para receber e persistir diagnósticos de auto-atualização do agente via RPC. Desabilitada por defeito; use apenas em ambientes onde o agente envia eventos de diagnóstico de versao.

| Variavel                                                   | Defeito          | Notas                                                    |
| ---------------------------------------------------------- | ---------------- | -------------------------------------------------------- |
| `AGENT_AUTO_UPDATE_DIAGNOSTICS_ENABLED`                    | `false`          | Liga o endpoint de ingestao de diagnósticos.             |
| `AGENT_AUTO_UPDATE_DIAGNOSTICS_RATE_LIMIT_WINDOW_MS`       | `60000`          | Janela do rate limit por agente.                         |
| `AGENT_AUTO_UPDATE_DIAGNOSTICS_RATE_LIMIT_MAX`             | `1`              | Maximo de diagnosticos por janela por agente.            |
| `AGENT_AUTO_UPDATE_DIAGNOSTICS_RETENTION_DAYS`             | `90`             | Retencao em dias dos registos na BD.                     |
| `AGENT_AUTO_UPDATE_DIAGNOSTICS_RETENTION_INTERVAL_MINUTES` | `1440`           | Cadencia do scheduler de prune (diario por defeito).     |
| `AGENT_AUTO_UPDATE_DIAGNOSTICS_PRUNE_BATCH_SIZE`           | `5000`           | Batch de linhas por ciclo de prune.                      |
| `AGENT_AUTO_UPDATE_DIAGNOSTICS_MAX_PAYLOAD_BYTES`          | `16384` (16 KiB) | Teto de bytes do campo `payload` por registo.            |
| `AGENT_AUTO_UPDATE_DIAGNOSTICS_MAX_MESSAGE_BYTES`          | `65536` (64 KiB) | Teto do JSON completo do evento de diagnostico recebido. |

## Configuracao de landing e HTTP base

| Variavel                        | Defeito        | Notas                                                                                                                                                    |
| ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROOT_LANDING_LANG`             | `auto`         | Lingua da pagina HTML em `GET /` (landing): `pt`, `en`, ou `auto` (detecao via `Accept-Language`; cai para PT quando ambiguo).                           |
| `HTTP_REQUEST_TIMEOUT_MS`       | `60000` (60 s) | `http.Server.requestTimeout`: tempo maximo que o servidor espera por um request HTTP completo (headers + body). Protege contra slow-loris. `0` desativa. |
| `JWT_ISSUER`                    | `plug_server`  | Campo `iss` nos JWTs emitidos (access e refresh). Validado em verify.                                                                                    |
| `JWT_AUDIENCE`                  | `plug_clients` | Campo `aud` nos JWTs emitidos. Validado em verify.                                                                                                       |
| `JWT_VERIFY_CACHE_TTL_MS`       | `30000`        | Cache em memoria de resultados de `verifyAccessToken`. Em cache hits, o `exp` e revalidado antes de retornar. `0` desativa.                              |
| `JWT_VERIFY_CACHE_MAX_SIZE`     | `2000`         | Maximo de entradas no cache de verify (evicao FIFO).                                                                                                     |
| `METRICS_RESPONSE_CACHE_TTL_MS` | `500`          | Cache do buffer de render Prometheus em `/metrics`. Colapsa rajadas de scrape. `0` desativa.                                                             |

## Leitura recomendada

| Topico                                                        | Documento                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| REST bridge, timeouts, rate limit                             | `docs/api/api_rest_bridge.md`                                                       |
| Relay Socket, quotas                                          | `docs/socket/socket_relay_protocol.md`                                              |
| Throughput hub ↔ agente                                       | `docs/performance/performance_hub_agent.md` (presets `.env`, checklist operacional) |
| Metricas e paineis                                            | `docs/observability/observability.md`                                               |
| Estados de utilizador, bloqueio admin, metricas `plug_auth_*` | `docs/api/user_status.md`                                                           |
| SSE, Redis, multi-instancia, OTel                             | `docs/studies/scaling_and_roadmap.md`                                               |

## Adendo: publish degradado de `client:custom.*`

Esta rodada acrescentou tres controlos operacionais para o caminho
`POST /api/v1/client/me/socket-events` e `socket:event.publish` quando o
Socket.IO Redis adapter esta activo, mas a contagem distribuida da room falha:

| Variavel                                                | Defeito | Notas                                                                                                                                                                      |
| ------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REST_SOCKET_EVENT_BEST_EFFORT_LOCAL_MAX_RECIPIENTS`    | `256`   | Teto local conservador para permitir emit em modo best-effort enquanto `fetchSockets()` falha. Acima disso, o hub responde `503` em vez de continuar fan-out sem controlo. |
| `REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_THRESHOLD` | `5`     | Numero de falhas consecutivas de contagem distribuida antes de abrir o circuito local de degradacao.                                                                       |
| `REST_SOCKET_EVENT_DISTRIBUTED_COUNT_FAILURE_OPEN_MS`   | `30000` | Janela durante a qual o circuito permanece aberto; nesse periodo, novos publishes recebem `503` retryable.                                                                 |

Sem Redis adapter activo, o caminho continua a usar a contagem local da room e
estes controlos nao entram em jogo. Com Redis adapter activo, o comportamento
passa a ser:

1. tentar contagem distribuida;
2. se funcionar, aplicar `REST_SOCKET_EVENT_MAX_RECIPIENTS` normalmente;
3. se falhar, permitir publish degradado apenas abaixo do teto local;
4. se as falhas se repetirem, abrir o circuito e devolver `503` ate a janela expirar.
