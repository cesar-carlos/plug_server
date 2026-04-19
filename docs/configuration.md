# Configuracao

## Fonte de verdade para defaults

- **Variaveis**: valores por defeito e parsing em [`src/shared/config/env.ts`](../src/shared/config/env.ts) (Zod `.default()` / `preprocess`).
- **Exemplo local**: [`.env.example`](../.env.example) (copiar para `.env`).
- **Documentacao narrativa**: `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md`, `docs/performance_hub_agent.md`, `docs/user_status.md` (estados de utilizador e bloqueio).
- **Mapa da documentacao**: `docs/README.md`.

Evite duplicar numeros em varios sitios sem atualizar `env.ts`; quando duvidar, confira o ficheiro de env ou `.env.example`.

### `HUB_INSTANCE_ID` (opcional)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `HUB_INSTANCE_ID` | *(vazio)* | Quando definida (string não vazia), o middleware global `hubInstanceIdMiddleware` adiciona o header HTTP `X-Hub-Instance-Id` com este valor a **toda resposta Express** (REST sob `/api/v1`, `/auth`, Swagger, `/metrics`, 404). Permite ao cliente validar afinidade de sessão (sticky) em qualquer endpoint, e correlacionar logs/métricas com a réplica que processou cada request. O campo JSON `isHubConnected` continua a ser por processo. Receitas de sticky session em `docs/nginx_production.md` § 12. |

### `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED` (opcional)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED` | `true` | Gateia o registro do handler de broadcast `client:agent.profile.updated` no namespace `/consumers`. Default mantém o comportamento sempre-ativo (clientes aprovados recebem push em mudanças do catálogo do agente). Setar `false` é um kill-switch operacional: o resto do `/consumers` (relay, consultas, agents:command) segue funcionando, e os clientes caem em modo polling para ler `profileVersion`. Mudança requer restart (Zod parseia `process.env` no boot). |

### `NODE_ENV=production` sem variável definida

Se a variável **não** estiver no ambiente, alguns defaults diferem em produção (desempenho):

| Comportamento | Produção (unset) | Não produção (unset) |
| ---------------- | ------------------ | --------------------- |
| `SOCKET_IO_TRANSPORTS` | `websocket` | `websocket,polling` |
| `SOCKET_IO_HTTP_COMPRESSION` | `false` | `true` |
| `PAYLOAD_FRAME_GZIP_LEVEL` | `3` | *(default zlib Node ~6)* |
| `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT` | `25` | `100` |

Definir explicitamente a variável no `.env` / plataforma ignora estes ramos.

## PayloadFrame (hub → agente)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES` | `524288` (512 KiB) | Só tenta gzip quando o JSON UTF-8 não excede este tamanho; ver `docs/performance_hub_agent.md`. |
| `PAYLOAD_FRAME_GZIP_LEVEL` | ver tabela *production* acima; senão *(omitido)* | Nível zlib `1`–`9` para gzip do hub; fora do ramo produção omitir = default Node (~6). |
| `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES` | `131072` (128 KiB) | Hub→agente (`encodePayloadFrameBridge`): JSON elegível para gzip com pelo menos este tamanho usa **gzip assíncrono**. `0` = sempre síncrono. |
| `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` | `65536` (64 KiB) | Hub **inbound** (`decodePayloadFrameAsync`): `cmp: gzip` com payload comprimido ≥ este tamanho usa **gunzip assíncrono**. `0` = sempre síncrono. |
| `SOCKET_AGENT_KNOWN_IDS_MAX` | `0` | Teto do conjunto de `agentId` “conhecidos” (offline) para REST; acima disto remove-se IDs **desligados** até ficar abaixo do limite. `0` = sem limite. |
| `SOCKET_AGENT_PROTOCOL_READY_GRACE_MS` | `100` | Fallback de estabilização após `agent:register` antes do primeiro `rpc:request`; o hub libera mais cedo com `agent:heartbeat` e também suporta `agent:ready` explícito quando o agente anuncia `extensions.protocolReadyAck`. Reduz corrida com `protocol_not_ready` do `plug_agente`. |
| `PAYLOAD_SIGN_OUTBOUND` | `false` | Assina frames de saída com `PAYLOAD_SIGNING_KEY` (HMAC-SHA256 sobre metadados + payload). |
| `PAYLOAD_SIGNING_KEY` | *(vazio)* | Chave compartilhada para assinar/verificar `PayloadFrame.signature`. Quando ausente e um frame chega assinado, a verificação **falha**. |
| `PAYLOAD_SIGNING_KEY_ID` | *(vazio)* | Identificador da chave (ex.: `hub-2026-q2`). Quando definida, frames recebidos **devem** trazer `signature.key_id` igual ao configurado — ausente ou divergente → `-32001` (`invalid_signature`). Sem essa env, o hub aceita assinaturas sem `key_id` (modo single-key, mais permissivo que o `payload-frame.schema.json` do agente). Use sempre que houver rotação ou múltiplas chaves activas. |

## Client thumbnail e password recovery

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `UPLOADS_DIR` | `uploads` | Diretório base para arquivos locais servidos em `/uploads`. Em produção, usar volume persistente. |
| `UPLOADS_PUBLIC_BASE_URL` | `APP_BASE_URL + /uploads` | Prefixo público das URLs de thumbnail. |
| `CLIENT_THUMBNAIL_MAX_BYTES` | `2097152` | Limite do upload da thumbnail (max **10 MiB** em `env.ts`); `client_max_body_size` no Nginx deve ser >= este valor — ver exemplo **11m** em `docs/nginx_production.md` e `deploy/nginx/plug_server.conf.example`. |
| `CLIENT_THUMBNAIL_WIDTH` | `256` | Largura final da thumbnail após normalização. |
| `CLIENT_THUMBNAIL_HEIGHT` | `256` | Altura final da thumbnail após normalização. |
| `CLIENT_THUMBNAIL_WEBP_QUALITY` | `82` | Qualidade da conversão para `webp`. |
| `CLIENT_PASSWORD_RECOVERY_TOKEN_EXPIRES_IN` | `30m` | Expiração do token de recuperação de senha do client. |
| `REST_CLIENT_THUMBNAIL_RATE_LIMIT_WINDOW_MS` | `60000` | Janela do rate limit para upload de thumbnail. |
| `REST_CLIENT_THUMBNAIL_RATE_LIMIT_MAX` | `20` | Máximo de uploads de thumbnail por janela. |
| `REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_WINDOW_MS` | `300000` | Janela do rate limit para request de recuperação de senha. |
| `REST_CLIENT_PASSWORD_RECOVERY_RATE_LIMIT_MAX` | `10` | Máximo de requests de recuperação por janela. |

## REST bridge e auditoria (env)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` | `256` | Janela interna ao materializar `sql.execute` em stream no REST (menos round-trips com valores maiores). |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_BYTES` | `268435456` | Teto agregado de bytes UTF-8 materializados no REST (resposta inicial + chunks). Complementa o limite por linhas para proteger contra payloads JSONB muito largos. |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_CHUNKS` | `100000` | Teto de `rpc:chunk` aceites na materialização REST. `0` continua a significar ilimitado, mas deixou de ser o default. |
| `SOCKET_AUDIT_BATCH_MAX` | `48` | Eventos por transação na auditoria Socket (1 = um INSERT por evento). |
| `SOCKET_AUDIT_BATCH_FLUSH_MS` | `200` | Intervalo máximo antes de flush do lote de auditoria. |
| `SOCKET_AUDIT_MAX_QUEUE` | `50000` | Cap de eventos em memória antes de começar a descartar os mais antigos. Evita crescimento sem limite quando a BD atrasa. |
| `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT` | ver tabela *production*; senão `100` | Percentagem de eventos de auditoria em `relay:rpc.chunk` persistidos. |

## Guards e limites do consumer socket

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS` | `30000` | **Legacy / ignorado.** Antes controlava um cache TTL de status; o guard agora revalida sempre na BD (lightweight snapshot) para tornar `block`/`unblock` instantâneo. Mantido no schema para não quebrar `.env` existentes. |
| `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET` | `32` | Teto de operações assíncronas simultâneas por socket consumer (`agents:command`, `relay:rpc.request`, `agents:stream_pull`, `relay:rpc.stream.pull`). |
| `SOCKET_RELAY_IDEMPOTENCY_MAX_ENTRIES_PER_CONVERSATION` | `1024` | Cap FIFO por conversa para o mapa de idempotência relay. |
| `SOCKET_RELAY_IDEMPOTENCY_MAX_TOTAL_ENTRIES` | `100000` | Cap FIFO global para o mapa de idempotência relay. `0` desativa o teto global. |

## Client → Agent: bearer token armazenado por par

Tabela `client_agent_accesses` ganhou a coluna opcional
`client_token VARCHAR(512)` (migration
`20260418190000_client_agent_access_client_token`). É o token que o cliente
final usa em `sql.execute params.client_token` no agente; armazenamos por par
`(client, agent)` para que cada cliente possa ter um token diferente em cada
agente, ou nenhum token (`NULL`).

| Endpoint | Comportamento |
| -------- | ------------- |
| `GET /api/v1/client/me/agents/{agentId}/client-token` | Retorna o token (ou `null`). 403 sem acesso aprovado. |
| `PUT /api/v1/client/me/agents/{agentId}/client-token` | Body `{ clientToken: string \| null }`. String vazia vira `null`. Tamanho ≤ 512. Não cria a linha de acesso. |
| `GET /api/v1/client/me/agents` e `GET /client/me/agents/{agentId}` | Cada agente carrega `hasClientToken: boolean` (sem expor o valor). |

Não há limite de rate específico para `PUT client-token` além do
`globalRateLimit` (`/api/v1` 300 req / 15 min) — pondere subir um limiter
dedicado se for usado em UI com edição contínua.

## REST: CORS, request id, rate limits

| Variável / Comportamento | Defeito | Notas |
| ------------------------ | ------- | ----- |
| `CORS_ORIGIN` | `*` em dev; **rejeitado** em produção | Aceita uma origem única **ou** lista separada por vírgula (`https://a,https://b`). Quando há lista (≥ 1 origem específica), `cors` valida o `Origin` contra o conjunto e habilita `Access-Control-Allow-Credentials`. `*` desativa credentials. |
| `HTTP_TRUST_PROXY` | `true` em produção | `1` hop. Necessário para `req.ip`/rate-limit corretos atrás de Nginx ou outro reverse proxy. |
| Header `x-request-id` | **sanitizado** | Aceito apenas se casar `^[A-Za-z0-9._-]{1,128}$`; caso contrário é substituído por `crypto.randomUUID()` para evitar log injection / header splitting. Sempre exposto na resposta no header `x-request-id`. |
| `credentialAuthRateLimit` | 25 / 15min | Aplicado **apenas** nos endpoints de credencial (`/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/logout`, `/auth/agent-login`, `/auth/registration/{review,status,approve,reject}`, `/client-auth/{register,login,refresh,logout,registration/*}`, `/client-auth/password-recovery/reset`). **Não** afeta `/auth/me`, `/auth/password`, `/client-auth/me`, `/client-auth/password`. Auto-bypass em test runner. |
| Cookie `refresh_token` / `client_refresh_token` | `HttpOnly`, `Secure` em prod, `SameSite=Strict`, `Path=/`, `Max-Age` = `JWT_REFRESH_EXPIRES_IN` (resp. client) | `Max-Age` calculado do mesmo env do JWT para evitar cookie órfão após revogação. Logout sempre limpa o cookie (mesmo com refresh inválido); change-password (user e client) também limpa para refletir invalidação de sessões. |
| `/metrics` (root e `/api/v1/metrics`) | exige `requireAuthAndActiveAccount` + role `admin` | Antes qualquer usuário autenticado conseguia raspar; agora restrito a admin. Use `HUB_INSTANCE_ID` para distinguir réplicas em scrape. |
| `/health/ready` | probe `SELECT 1` no Postgres com timeout 1500 ms | Retorna `503` + `status:"degraded"` quando o probe falha; `200` caso contrário. Em `NODE_ENV=test` o probe é omitido. `/health/live` continua sempre `200` (independente da BD). |
| `/uploads` (estático) | `etag: true`, `maxAge: 7d`, `immutable`, `dotfiles: deny`, `fallthrough: false`, `index: false` | Endurece o `express.static` para evitar listagem, dotfiles e relisten ao 404. |
| `express.urlencoded` | `extended: false` | Usa o parser `querystring` nativo (sem `qs`); só os formulários HTML de aprovação dependem dele e carregam `{token, reason?}`. |
| Upload de thumbnail | multer + validação magic-bytes via `sharp().metadata()` | Allowlist `image/png|jpeg|webp|gif`. `MulterError` (size limit, etc.) é convertido para `400 BAD_REQUEST` em vez de `500`. |

## Manutencao de dados Agent

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `AGENT_PROFILE_REVISION_RETENTION_DAYS` | `180` | Retencao do historico `agent_profile_revisions` (snapshots versionados do perfil). |
| `AGENT_PROFILE_IDEMPOTENCY_RETENTION_DAYS` | `30` | TTL operacional para `agent_profile_write_idempotencies`; evita idempotencia eterna na BD. |
| `AGENT_PROFILE_MAINTENANCE_INTERVAL_MINUTES` | `1440` | Cadencia do scheduler que poda revisoes antigas e chaves de idempotencia expiradas. |
| `AGENT_PROFILE_MAINTENANCE_PRUNE_BATCH_SIZE` | `5000` | Batch de prune para tabelas de perfil do agente. |
| `CLIENT_AGENT_ACCESS_EXPIRY_SWEEP_INTERVAL_MINUTES` | `60` | Cadencia do sweep que fecha pedidos `pending` cujo token de aprovacao expirou. |
| `CLIENT_AGENT_ACCESS_EXPIRY_SWEEP_BATCH_SIZE` | `1000` | Batch do sweep de expiracao `Client -> Agent`. |

## Socket.IO (Engine.IO)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_IO_SERVE_CLIENT` | `false` | Não servir o bundle `socket.io` a partir deste servidor (hub API). |
| `SOCKET_IO_HTTP_COMPRESSION` | ver tabela *production*; senão `true` | Compressão nas respostas **polling**; `false` se só usas `websocket`. |
| `SOCKET_IO_PING_INTERVAL_MS` / `SOCKET_IO_PING_TIMEOUT_MS` | *(omitido)* | Heartbeat Engine.IO (defaults 25000 / 20000 ms). |
| `SOCKET_IO_TRANSPORTS` | ver tabela *production*; senão `websocket,polling` | Produção sem variável: só `websocket` (menos CPU/handshake). |
| `SOCKET_IO_PER_MESSAGE_DEFLATE` | `false` | Evita deflate WS duplicado com `PayloadFrame`. |
| `SOCKET_IO_MAX_HTTP_BUFFER_BYTES` | `10485760` | Teto alinhado a frames de 10 MiB. |

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
- `profile` opcional (objeto livre, validado em sync downstream)

Toda rejeicao sai pelo evento dedicado **`agent:register_error`** em **JSON
puro** (NAO `PayloadFrame`) com `{ code, reason, message }`. Tabela completa
de `reason` em `docs/api_rest_bridge.md` -> *Falhas de `agent:register` ate o
ownership ser criado* e `docs/migracao_plug_agente_namespaces.md`.

## Ownership de agentes

O ownership oficial do agente nasce em `agent:register`, depois de um `agent-login` válido. Nesse mesmo registo o hub consulta `agent.getProfile` e cria/atualiza automaticamente o cadastro do agente no catálogo, incluindo `lastLoginUserId` como atributo operacional. O resultado RPC pode incluir `profile_version` (contador monotónico no servidor); o hub usa-o para ordenar o *pull sync* e detetar divergência quando a versão coincide mas o conteúdo do perfil não bate com o catálogo. Não existem mais variáveis de ambiente nem rate limits dedicados ao antigo fluxo HTTP de self-service bind em `/api/v1/me/agents`, e o catálogo também não aceita mais criação/edição manual por HTTP; por gestão administrativa, apenas a desativação permanece exposta. Atualização self-service pelo próprio agente (fora do registo) está em `PATCH /api/v1/agents/{agentId}/profile`, documentada no OpenAPI (`/docs`, `/docs.json`), e também em `agent:profile.update` no namespace `/agents`.

## Leitura recomendada

| Topico | Documento |
| ------ | --------- |
| REST bridge, timeouts, rate limit | `docs/api_rest_bridge.md` |
| Relay Socket, quotas | `docs/socket_relay_protocol.md` |
| Throughput hub ↔ agente | `docs/performance_hub_agent.md` (presets `.env`, checklist operacional) |
| Metricas e paineis | `docs/observability.md` |
| Estados de utilizador, bloqueio admin, metricas `plug_auth_*` | `docs/user_status.md` |
| SSE, Redis, multi-instancia, OTel | `docs/scaling_and_roadmap.md` |
