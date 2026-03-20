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
| `PAYLOAD_SIGN_OUTBOUND` | `false` | Assina frames de saída com `PAYLOAD_SIGNING_KEY`. |

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
