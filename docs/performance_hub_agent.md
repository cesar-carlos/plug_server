# Desempenho: hub (`plug_server`) ↔ `plug_agente`

Guia de otimização e variáveis relevantes. Complementa `docs/api_rest_bridge.md` e `docs/socket_relay_protocol.md`. Defaults formais: `docs/configuration.md` (`env.ts`, `.env.example`).

**Canais do consumer:** REST (`POST /agents/commands`) vs Socket (`/consumers`) — escolha do cliente; REST agrega streams. Resumo em `docs/project_overview.md` (*Dois canais para comandos ao agente*).

## Transporte Socket.IO

- **PayloadFrame** já aplica gzip no nível da aplicação (modo **auto** por defeito: só gzip se menor que JSON UTF-8). O Engine.IO, por defeito, pode aplicar **permessage-deflate** no WebSocket — compressão duplicada e CPU extra.
- **`SOCKET_IO_PER_MESSAGE_DEFLATE=false`** (recomendado): desliga deflate na camada WS quando se usa `PayloadFrame` com gzip opcional.
- **`SOCKET_IO_MAX_HTTP_BUFFER_BYTES`**: deve cobrir o teto de frame do contrato (**10 MB** alinhado a `payload_frame.ts`). Valores abaixo disso podem falhar em payloads grandes mesmo com JSON-RPC válido.
- **`SOCKET_IO_TRANSPORTS`**: `websocket,polling` (defeito) para compatibilidade; em produção com clientes estáveis, `websocket` reduz handshake inicial e evita long-polling.

## REST vs streaming

- **`POST /api/v1/agents/commands`** com `sql.execute` que devolve `stream_id`: o hub **materializa** o stream (vários `rpc:stream.pull` internos) e responde HTTP com **um** JSON — mais latência e RAM que Socket.
- Para resultados muito grandes, preferir **`agents:command`** ou **relay** com chunks em tempo real e `stream_pull` explícito.

## Variáveis de ambiente (throughput)

| Variável | Efeito |
| -------- | ------ |
| `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` | Janela no materializador REST: maior = menos round-trips, mais RAM por stream. |
| `SOCKET_REST_AGENT_MAX_INFLIGHT` / `MAX_QUEUE` / `QUEUE_WAIT_MS` | Paralelismo e fila por agente no bridge REST. |
| `SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS` / `..._CONVERSATION_STARTS` | Teto de pedidos relay por janela; subir em workloads intensos (com cuidado). |
| `SOCKET_RELAY_MAX_BUFFERED_CHUNKS_*` | Backpressure relay; mais buffer = mais throughput até ao limite de memória. |
| `SOCKET_AUDIT_BATCH_MAX` / `FLUSH_MS` | Menos round-trips à DB em auditoria. |
| `REST_AGENTS_COMMANDS_RATE_LIMIT_*` | Limite por IP no REST; produção pode precisar subir com muitos clientes legítimos. |

## Escala horizontal

- Correlação REST e muito estado do bridge ficam **em memória** por instância. Várias réplicas HTTP sem afinidade ou store partilhado degradam o comportamento. Ver notas em `api_rest_bridge.md` (gaps / réplicas).

## Agente (`plug_agente`)

- Afinar limites negociados no handshake (`max_rows`, streaming, chunking) e carga SQL no próprio agente; o hub só encaminha.

## Métricas

- `GET /metrics` / `GET /api/v1/metrics`: latência bridge REST, relay, pulls de materialização, auditoria — usar para validar mudanças de env.
