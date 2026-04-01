# Configuracao

## Fonte de verdade para defaults

- **Variaveis**: valores por defeito e parsing em [`src/shared/config/env.ts`](../src/shared/config/env.ts) (Zod `.default()` / `preprocess`).
- **Exemplo local**: [`.env.example`](../.env.example) (copiar para `.env`).
- **Documentacao narrativa**: `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md`, `docs/performance_hub_agent.md`, `docs/user_status.md` (estados de utilizador e bloqueio).

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

## User agents — self-service (`POST /api/v1/me/agents`)

A verificação de “online” usa o registo **em memória do processo** (`agentRegistry`). Com **várias réplicas** HTTP/Socket sem afinidade de sessão, o pedido pode cair num nó onde o agente não está registado — o bind falha com `422` / `AGENT_NOT_ONLINE_FOR_USER` mesmo com o agente ligado doutro lado. Mitigações típicas: sticky sessions, colocar REST e Socket no mesmo nó, ou presença partilhada (ex. Redis) numa evolução futura.

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `REST_ME_AGENTS_POST_RATE_LIMIT_WINDOW_MS` | `60000` | Janela por utilizador autenticado (`JWT sub`). |
| `REST_ME_AGENTS_POST_RATE_LIMIT_MAX` | `40` | Máximo de pedidos `POST /api/v1/me/agents` por janela. |

## Leitura recomendada

| Topico | Documento |
| ------ | --------- |
| REST bridge, timeouts, rate limit | `docs/api_rest_bridge.md` |
| Relay Socket, quotas | `docs/socket_relay_protocol.md` |
| Throughput hub ↔ agente | `docs/performance_hub_agent.md` (presets `.env`, checklist operacional) |
| Metricas e paineis | `docs/observability.md` |
| Estados de utilizador, bloqueio admin, metricas `plug_auth_*` | `docs/user_status.md` |
| SSE, Redis, multi-instancia, OTel | `docs/scaling_and_roadmap.md` |
