# Desempenho: hub (`plug_server`) ↔ `plug_agente`

Guia de otimização e variáveis relevantes. Complementa `docs/api_rest_bridge.md` e `docs/socket_relay_protocol.md`. Defaults formais: `docs/configuration.md` (`env.ts`, `.env.example`).

**Produção (`NODE_ENV=production`) sem variável definida:** o `env.ts` aplica automaticamente `SOCKET_IO_TRANSPORTS=websocket`, `SOCKET_IO_HTTP_COMPRESSION=false`, `PAYLOAD_FRAME_GZIP_LEVEL=3`, `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT=25`. Ver tabela em `docs/configuration.md`. Definir a variável explicitamente substitui estes ramos.

**Canais do consumer:** REST (`POST /api/v1/agents/commands`) vs Socket (`/consumers`) — escolha do cliente; REST agrega streams. Resumo em `docs/PROJECT_OVERVIEW.md`.

## Transporte Socket.IO

- **PayloadFrame** já aplica gzip no nível da aplicação (modo **auto** por defeito: só gzip se menor que JSON UTF-8). O Engine.IO, por defeito, pode aplicar **permessage-deflate** no WebSocket — compressão duplicada e CPU extra.
- **Teto interno de gzip** (`payload_frame.ts` + `PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES`, defeito **524288**): JSON UTF-8 acima desse tamanho não passa por tentativa de gzip na codificação do hub (`cmp: none`); subir o valor (até **10 MiB**) se precisares de gzip em cargas grandes; payloads seguem dentro do limite de **10 MB** do contrato.
- **`PAYLOAD_FRAME_GZIP_LEVEL`** (opcional, `1`–`9`): nível zlib para `gzipSync` do hub. Omitir mantém o default do Node (~6). Valores **1–3** reduzem CPU em hubs com muito tráfego comprimido, à custa de frames ligeiramente maiores.
- **`PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES`** (defeito **131072**): no caminho bridge (`encodePayloadFrameBridge` para `rpc:request` ao agente), payloads JSON **elegíveis para gzip** com pelo menos este tamanho em UTF-8 usam **gzip assíncrono** (`zlib.gzip` via `promisify`) em vez de `gzipSync`, aliviando bloqueios longos no event loop em frames grandes. **`0`** força sempre gzip síncrono (comportamento antigo).
- **Envelope `traceId` em pedidos ao agente**: `rpc:request` (REST/relay) e `rpc:stream.pull` usam **`omitTraceId: true`** no envelope; a correlação fica em `requestId` / `meta.trace_id` no JSON-RPC quando aplicável.
- **Inbound `decodePayloadFrameAsync`**: `rpc:response`, acks do agente, decode do relay (`relay:rpc.request` / `relay:rpc.stream.pull`) e agora também `rpc:chunk` / `rpc:complete` usam decode assíncrono ordenado por socket. Para `cmp: gzip` e comprimido ≥ **`PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES`** (defeito **65536**), usa **gunzip assíncrono**. `0` = sempre síncrono em todos os usos async.
- **`SOCKET_IO_SERVE_CLIENT=false`** (defeito): o hub não expõe o ficheiro cliente `socket.io` por HTTP — menos trabalho no pipeline e superfície menor. Clientes devem usar `socket.io-client` via npm/CDN.
- **`SOCKET_IO_HTTP_COMPRESSION`**: compressão zlib nas respostas do transporte **polling**. Se em produção só usas **`SOCKET_IO_TRANSPORTS=websocket`**, definir `SOCKET_IO_HTTP_COMPRESSION=false` evita trabalho inútil em upgrades/handshake ocasional de polling.
- **`SOCKET_IO_PER_MESSAGE_DEFLATE=false`** (recomendado): desliga deflate na camada WS quando se usa `PayloadFrame` com gzip opcional.
- **`SOCKET_IO_MAX_HTTP_BUFFER_BYTES`**: deve cobrir o teto de frame do contrato (**10 MB** alinhado a `payload_frame.ts`). Valores abaixo disso podem falhar em payloads grandes mesmo com JSON-RPC válido.
- **`SOCKET_IO_TRANSPORTS`**: `websocket,polling` (defeito) para compatibilidade; em produção com clientes estáveis, `websocket` reduz handshake inicial e evita long-polling.
- **Heartbeat** (`SOCKET_IO_PING_INTERVAL_MS`, `SOCKET_IO_PING_TIMEOUT_MS`): opcionais; defaults Engine.IO **25000** / **20000** ms. Intervalos maiores reduzem tráfego e CPU com muitas ligações lentas; garantir `pingInterval > pingTimeout` e ajustar timeouts de cliente/rede em conjunto.
- **`SOCKET_IO_TRANSPORTS=websocket`**: o hub define `allowUpgrades: false` no Engine.IO (sem tentativa de upgrade polling→WS quando só existe transporte WebSocket).
- **PayloadFrame em streams relay** (`relay:rpc.chunk` / `relay:rpc.complete`, acks em batch): o envelope pode **omitir `traceId`** para evitar `randomUUID()` por mensagem em caminhos de alto débito; a correlação continua via `requestId` no envelope e nos dados JSON-RPC.
- **Relay hub → consumer**: emissões para o consumer (`relay:rpc.response`, `relay:rpc.chunk`, `relay:rpc.complete`, acks relay, replay idempotente, timeout) passam por **`encodePayloadFrameBridge`** dentro de **`relay_outbound_queue.ts`**: fila **serial por `requestId`** (`enqueueRelayOutbound`) para preservar ordem com gzip assíncrono (`PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES`, mesmo limiar que hub→agente). Com **`PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES=0`**, o caminho volta a gzip síncrono dentro do bridge. Mitigações de CPU/tamanho: `PAYLOAD_FRAME_GZIP_LEVEL` (1–3), menos linhas por chunk no agente, payloads abaixo do limiar de gzip.
- **Métricas da fila relay** (`GET /metrics`): `plug_socket_relay_outbound_queue_*` (jobs terminados/falhados, soma/média/máx. duração do job em ms, gauge `inflight_request_ids`). PromQL em `docs/observability.md`.
- **Overload gate O(1)**: os handlers de `/consumers` leem estado cacheado da fila relay (backlog/p95) e o refresh pesado (percentis + varredura órfãos) fica no sweep periódico/métricas. Isso reduz CPU por evento em `relay:conversation.start`, `relay:rpc.request` e `relay:rpc.stream.pull`.
- **Drain em lote por `requestId`**: chunks buffered são drenados em jobs agregados da fila outbound (sem perder ordenação), reduzindo custo de Promise chaining e de encode por chunk em bursts.
- **Lookup relay durante `rpc:stream.pull`**: ao drenar buffer interno após um pull, o hub reutiliza a rota relay já resolvida onde possível (`rpc_bridge_stream_pull.ts`), evitando consultas repetidas ao registo por chunk no mesmo tick.

## REST vs streaming

- **Pipeline HTTP (`app.ts`)**: o rate limit global de **`/api/v1`** corre **antes** de `express.json`, para rejeitar abusos sem parse de corpo; a rota pesada continua protegida por `REST_AGENTS_COMMANDS_RATE_LIMIT_*` depois de `requireAuth` (métricas `plug_rest_http_rate_limit_*`).
- **`POST /api/v1/agents/commands`** com `sql.execute` que devolve `stream_id`: o hub **materializa** o stream (vários `rpc:stream.pull` internos) e responde HTTP com **um** JSON — mais latência e RAM que Socket.
- **Junção de linhas no materializador** (`mergeSqlStreamRpcResponse`): os chunks são concatenados com loop (sem `push(...rows)`), para não bater nos limites de argumentos do motor JS quando há dezenas de milhares de linhas por chunk.
- Para resultados muito grandes, preferir **`agents:command`** ou **relay** com chunks em tempo real e `stream_pull` explícito.

## Variáveis de ambiente (throughput)

| Variável | Efeito |
| -------- | ------ |
| `SOCKET_REST_STREAM_PULL_WINDOW_SIZE` | Janela no materializador REST (defeito **256**): maior = menos round-trips, mais RAM por stream. |
| `SOCKET_REST_SQL_STREAM_MATERIALIZE_MAX_ROWS` / `MAX_CHUNKS` | Tetos na agregação REST de `sql.execute` com `stream_id` (defeito **1_000_000** linhas; chunks **0** = sem limite). Exceder → **503** fail-fast; streams muito grandes devem usar Socket. |
| `SOCKET_REST_AGENT_MAX_INFLIGHT` / `MAX_QUEUE` / `QUEUE_WAIT_MS` | Paralelismo e fila por agente no bridge REST (defeitos **32** / **64** / **200** ms). Observar `plug_socket_relay_rest_dispatch_*` em `GET /metrics` para profundidade agregada; subir `INFLIGHT`/`MAX_QUEUE` se bursts forem saudáveis e o agente aguentar; `QUEUE_WAIT_MS` baixo falha cedo com `Retry-After`. |
| `SOCKET_RELAY_RATE_LIMIT_MAX_REQUESTS` / `..._CONVERSATION_STARTS` | Teto de pedidos relay por janela; subir em workloads intensos (com cuidado). |
| `SOCKET_RELAY_MAX_BUFFERED_CHUNKS_*` | Backpressure relay (defeitos **256** por pedido, **25600** global); mais buffer = mais throughput até ao limite de memória. |
| `SOCKET_AUDIT_BATCH_MAX` / `FLUSH_MS` | Menos round-trips à DB em auditoria. |
| `REST_AGENTS_COMMANDS_RATE_LIMIT_*` | Limite por utilizador (`sub`) no REST + opcional por IP; `agents:command` usa os mesmos números (contador Socket separado). |
| `PAYLOAD_FRAME_GZIP_LEVEL` | Trade-off CPU vs tamanho no gzip do `PayloadFrame` (hub → agente / relay). |
| `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES` | Gzip assíncrono no bridge (defeito **131072** UTF-8); `0` = só síncrono. |
| `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` | Gunzip assíncrono inbound (defeito **65536** bytes comprimidos); `0` = só síncrono. |
| `SOCKET_AGENT_KNOWN_IDS_MAX` | Limite do conjunto de agentIds offline lembrados (`0` = ilimitado). |
| `SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT` | Amostragem em `relay:rpc.chunk` (fora de produção **100**; em produção sem env **25**). |
| `SOCKET_IO_SERVE_CLIENT` / `HTTP_COMPRESSION` / `PING_*` | Ver secção *Transporte Socket.IO* acima. |

## Presets recomendados (`.env`)

Copia as linhas para o teu `.env` e ajusta por carga. Valores aqui **substituem** os defaults de `env.ts`. Fragmento comentado também em [`.env.example`](../.env.example) (secção *Performance presets*).

### Baseline produção (sem copiar nada)

Com `NODE_ENV=production` e variáveis **omitidas**, o hub já aplica: `SOCKET_IO_TRANSPORTS=websocket`, `SOCKET_IO_HTTP_COMPRESSION=false`, `PAYLOAD_FRAME_GZIP_LEVEL=3`, amostragem de auditoria em chunks relay a **25%**. Confirma `SOCKET_IO_PER_MESSAGE_DEFLATE=false` (defeito).

### Alto throughput (muito relay + streams, RAM suficiente)

- Menos round-trips no materializador REST e mais buffer no relay (mais memória por pedido / global).

```bash
SOCKET_REST_STREAM_PULL_WINDOW_SIZE=512
SOCKET_RELAY_MAX_BUFFERED_CHUNKS_PER_REQUEST=512
SOCKET_RELAY_MAX_TOTAL_BUFFERED_CHUNKS=51200
# Opcional: mais comandos REST concorrentes por agente (monitorar latência p99)
# SOCKET_REST_AGENT_MAX_INFLIGHT=48
# SOCKET_REST_AGENT_MAX_QUEUE=96
```

### Priorizar menos bloqueio do event loop (JSON/gzip grandes)

- Gzip/gunzip assíncronos disparam mais cedo (útil quando há muitas respostas comprimidas médias/grandes).

```bash
PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES=65536
PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES=32768
```

### Mais compressão hub→agente em payloads grandes

- Só se a CPU aguentar; sobe uso de zlib até ao teto de frame.

```bash
PAYLOAD_FRAME_MAX_GZIP_INPUT_BYTES=1048576
# PAYLOAD_FRAME_GZIP_LEVEL=2
```

### VM pequena / menos trabalho de fundo

- Menos tarefas async zlib para payloads médios; sweep de idempotência menos frequente.

```bash
PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES=262144
PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES=131072
SOCKET_RELAY_IDEMPOTENCY_CLEANUP_INTERVAL_MS=180000
```

### Resultados muito grandes: canal em vez de só tunar env

- Para menor latência e RAM, preferir **`agents:command`** ou **relay** com chunks em tempo real em vez de aumentar só a janela do REST materializado.

## Checklist operacional

1. Baseline em `/metrics` (latência bridge REST, relay, `plug_rest_sql_stream_materialize_pulls_total`) antes de mudar env.
2. Garantir **sem** dupla compressão: `SOCKET_IO_PER_MESSAGE_DEFLATE=false` e, em produção WS-only, `SOCKET_IO_HTTP_COMPRESSION=false`.
3. Depois de alterar buffers relay/REST, monitorar RSS do processo e rejeições (`503` / overload).
4. Multi-instância HTTP: presets **não** resolvem partilha de estado — ver secção seguinte e `api_rest_bridge.md`.

## Escala horizontal

- Correlação REST e muito estado do bridge ficam **em memória** por instância. Várias réplicas HTTP sem afinidade ou store partilhado degradam o comportamento. Ver notas em `api_rest_bridge.md` (gaps / réplicas).

## Agente (`plug_agente`)

- Afinar limites negociados no handshake (`max_rows`, streaming, chunking) e carga SQL no próprio agente; o hub só encaminha.
- Benchmark E2E com ODBC e `multi_result` (repositório `plug_agente`): visão geral hub ↔ agente em `docs/e2e_benchmark_hub_agent.md`.

## Métricas

- `GET /metrics` / `GET /api/v1/metrics`: latência bridge REST, relay, pulls de materialização, auditoria — usar para validar mudanças de env.
- Novas séries úteis para hot path relay:
  - `plug_socket_relay_overload_check_*`
  - `plug_socket_relay_frame_decode_*`
  - `plug_socket_relay_command_validate_*`
  - `plug_socket_relay_bridge_encode_*`
  - `plug_socket_relay_chunk_forward_jobs_*`
  - `plug_socket_relay_buffer_drain_*`
  - `plug_socket_relay_outbound_queue_overload_state_refresh_total`
  - `plug_socket_relay_outbound_queue_overload_cache_p95_ms`
