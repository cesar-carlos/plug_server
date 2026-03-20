# Configuracao

## Fonte de verdade para defaults

- **Variaveis**: valores por defeito e parsing em [`src/shared/config/env.ts`](../src/shared/config/env.ts) (Zod `.default()`).
- **Exemplo local**: [`.env.example`](../.env.example) (copiar para `.env`).
- **Documentacao narrativa**: `docs/api_rest_bridge.md`, `docs/socket_relay_protocol.md`, `docs/performance_hub_agent.md`.

Evite duplicar numeros em varios sitios sem atualizar `env.ts`; quando duvidar, confira o ficheiro de env ou `.env.example`.

## PayloadFrame (hub → agente)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES` | `524288` (512 KiB) | Só tenta gzip quando o JSON UTF-8 não excede este tamanho; ver `docs/performance_hub_agent.md`. |
| `PAYLOAD_FRAME_GZIP_LEVEL` | *(omitido)* | Nível zlib `1`–`9` para gzip do hub; omitir = default Node (~6). Valores baixos = menos CPU. |
| `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES` | `262144` (256 KiB) | Hub→agente (`encodePayloadFrameBridge`): JSON elegível para gzip com pelo menos este tamanho usa **gzip assíncrono** (pool de threads) em vez de `gzipSync`. `0` = sempre síncrono (comportamento anterior). |
| `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` | `131072` (128 KiB) | Hub **inbound** (`decodePayloadFrameAsync`): `cmp: gzip` com payload comprimido ≥ este tamanho usa **gunzip assíncrono**. `0` = sempre síncrono. |
| `SOCKET_AGENT_KNOWN_IDS_MAX` | `0` | Teto do conjunto de `agentId` “conhecidos” (offline) para REST; acima disto remove-se IDs **desligados** até ficar abaixo do limite. `0` = sem limite. |
| `PAYLOAD_SIGN_OUTBOUND` | `false` | Assina frames de saída com `PAYLOAD_SIGNING_KEY`. |

## REST bridge e auditoria (env)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` | `128` | Janela interna ao materializar `sql.execute` em stream no REST (menos round-trips com valores maiores). |
| `SOCKET_AUDIT_BATCH_MAX` | `48` | Eventos por transação na auditoria Socket (1 = um INSERT por evento). |
| `SOCKET_AUDIT_BATCH_FLUSH_MS` | `200` | Intervalo máximo antes de flush do lote de auditoria. |
| `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT` | `100` | Percentagem de eventos de auditoria em `relay:rpc.chunk` que são persistidos (`100` = todos). |

## Socket.IO (Engine.IO)

| Variável | Defeito | Notas |
| -------- | ------- | ----- |
| `SOCKET_IO_SERVE_CLIENT` | `false` | Não servir o bundle `socket.io` a partir deste servidor (hub API). |
| `SOCKET_IO_HTTP_COMPRESSION` | `true` | Compressão nas respostas **polling**; `false` se só usas `websocket`. |
| `SOCKET_IO_PING_INTERVAL_MS` / `SOCKET_IO_PING_TIMEOUT_MS` | *(omitido)* | Heartbeat Engine.IO (defaults 25000 / 20000 ms). |
| `SOCKET_IO_TRANSPORTS` | `websocket,polling` | Produção: só `websocket` reduz latência. |
| `SOCKET_IO_PER_MESSAGE_DEFLATE` | `false` | Evita deflate WS duplicado com `PayloadFrame`. |
| `SOCKET_IO_MAX_HTTP_BUFFER_BYTES` | `10485760` | Teto alinhado a frames de 10 MiB. |

## Leitura recomendada

| Topico | Documento |
| ------ | --------- |
| REST bridge, timeouts, rate limit | `docs/api_rest_bridge.md` |
| Relay Socket, quotas | `docs/socket_relay_protocol.md` |
| Throughput hub ↔ agente | `docs/performance_hub_agent.md` |
| Metricas e paineis | `docs/observability.md` |
| SSE, Redis, multi-instancia, OTel | `docs/scaling_and_roadmap.md` |
