# Configuracao

## Fonte de verdade para defaults

- **Variaveis**: valores por defeito e parsing em [`src/shared/config/env.ts`](../src/shared/config/env.ts) (Zod `.default()` / `preprocess`).
- **Exemplo local**: [`.env.example`](../.env.example) (copiar para `.env`).
- **Documentacao narrativa**: `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md`, `docs/performance_hub_agent.md`, `docs/user_status.md` (estados de utilizador e bloqueio).
- **Mapa da documentacao**: `docs/README.md`.

Evite duplicar numeros em varios sitios sem atualizar `env.ts`; quando duvidar, confira o ficheiro de env ou `.env.example`.

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
| `PAYLOAD_SIGN_OUTBOUND` | `false` | Assina frames de saída com `PAYLOAD_SIGNING_KEY`. |

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
| `SOCKET_AUDIT_BATCH_MAX` | `48` | Eventos por transação na auditoria Socket (1 = um INSERT por evento). |
| `SOCKET_AUDIT_BATCH_FLUSH_MS` | `200` | Intervalo máximo antes de flush do lote de auditoria. |
| `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT` | ver tabela *production*; senão `100` | Percentagem de eventos de auditoria em `relay:rpc.chunk` persistidos. |

## Socket.IO (Engine.IO)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_IO_SERVE_CLIENT` | `false` | Não servir o bundle `socket.io` a partir deste servidor (hub API). |
| `SOCKET_IO_HTTP_COMPRESSION` | ver tabela *production*; senão `true` | Compressão nas respostas **polling**; `false` se só usas `websocket`. |
| `SOCKET_IO_PING_INTERVAL_MS` / `SOCKET_IO_PING_TIMEOUT_MS` | *(omitido)* | Heartbeat Engine.IO (defaults 25000 / 20000 ms). |
| `SOCKET_IO_TRANSPORTS` | ver tabela *production*; senão `websocket,polling` | Produção sem variável: só `websocket` (menos CPU/handshake). |
| `SOCKET_IO_PER_MESSAGE_DEFLATE` | `false` | Evita deflate WS duplicado com `PayloadFrame`. |
| `SOCKET_IO_MAX_HTTP_BUFFER_BYTES` | `10485760` | Teto alinhado a frames de 10 MiB. |

## Ownership de agentes

O ownership oficial do agente nasce em `agent:register`, depois de um `agent-login` válido. Nesse mesmo registo o hub consulta `agent.getProfile` e cria/atualiza automaticamente o cadastro do agente no catálogo, incluindo `lastLoginUserId` como atributo operacional. Não existem mais variáveis de ambiente nem rate limits dedicados ao antigo fluxo HTTP de self-service bind em `/api/v1/me/agents`, e o catálogo também não aceita mais criação/edição manual por HTTP; por gestão administrativa, apenas a desativação permanece exposta.

## Leitura recomendada

| Topico | Documento |
| ------ | --------- |
| REST bridge, timeouts, rate limit | `docs/api_rest_bridge.md` |
| Relay Socket, quotas | `docs/socket_relay_protocol.md` |
| Throughput hub ↔ agente | `docs/performance_hub_agent.md` (presets `.env`, checklist operacional) |
| Metricas e paineis | `docs/observability.md` |
| Estados de utilizador, bloqueio admin, metricas `plug_auth_*` | `docs/user_status.md` |
| SSE, Redis, multi-instancia, OTel | `docs/scaling_and_roadmap.md` |
