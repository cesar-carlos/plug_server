# Socket Client SDK Minimo (Relay)

Data: 2026-03-20

Guia rapido para cliente Socket no modo relay (`/consumers`), com tratamento de
`PayloadFrame` binario + `gzip`.

Este documento cobre transporte e uso do canal Socket. Regras de negocio sobre
ownership de `Agent`, aprovacao de acesso de `Client` e consulta de agentes
aprovados vivem em `docs/client_agent_business_rules.md`.
Mapa geral da documentacao: `docs/README.md`.

**Canal alternativo (REST):** os mesmos comandos JSON-RPC podem ser enviados por
`POST /api/v1/agents/commands` sem Socket no consumer; o REST **nao** expoe
streaming progressivo (resultado agregado num unico JSON). Para chunks em tempo
real, usar este guia / `agents:command` / relay. Ver `docs/PROJECT_OVERVIEW.md`.

## Eventos e formato

- **Handshake**: `connection:ready` (PayloadFrame desde versão mais recente)
- Controle em JSON: `relay:conversation.*`, `relay:rpc.accepted`, `relay:rpc.stream.pull_response`
- Dados em `PayloadFrame`: `relay:rpc.request`, `relay:rpc.response`, `relay:rpc.chunk`, `relay:rpc.complete`, `relay:rpc.request_ack`, `relay:rpc.batch_ack`, `relay:rpc.stream.pull`

### Handshake: `connection:ready`

Emitido imediatamente após autenticação bem-sucedida em ambos os namespaces (`/agents` e `/consumers`). **Desde versão mais recente, este evento é enviado como `PayloadFrame`** para consistência com outros eventos RPC.

**Payload lógico após decode**:

```json
{
  "id": "<socket.id>",
  "message": "Socket connected successfully",
  "user": { "sub": "<user_id>", "iat": 123, "exp": 456, "role": "..." }
}
```

**Implementação no cliente**:

```typescript
socket.on("connection:ready", (rawPayload: unknown) => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    throw new Error(`Handshake decode failed: ${decoded.error.message}`);
  }
  // decoded.value = { id, message, user }
  console.log("Connected:", decoded.value);
});
```

**Nota de compatibilidade**: existe um shim transitório isolado por `SOCKET_CONNECTION_READY_COMPAT_MODE`, mas o contrato padrão e suportado é `PayloadFrame`. O modo legado `raw_json` tem remoção planejada após `2026-09-30`.

## Estrutura do PayloadFrame

```ts
type PayloadFrame = {
  schemaVersion: "1.0";
  enc: "json";
  cmp: "none" | "gzip";
  contentType: "application/json";
  originalSize: number;
  compressedSize: number;
  payload: Uint8Array | number[] | string;
  traceId?: string;
  requestId?: string;
  signature?: { alg: "hmac-sha256"; value: string; key_id?: string };
};
```

Em alguns eventos de **alto debito** (`relay:rpc.chunk`, `relay:rpc.complete`, acks relay), o servidor pode omitir `traceId` no envelope; usar `requestId` para correlacao.

## Limites e comportamento do hub (resumo)

- **Tamanho de frame**: até **10 MiB** comprimido/decodificado no contrato do hub (`payload_frame.ts`); validar no cliente antes de enviar SQL/parametros enormes.
- **Rate limits**: relay (`relay:conversation.start`, `relay:rpc.request`) e `agents:command` no namespace `/consumers` têm tetos por janela; REST `POST /api/v1/agents/commands` por utilizador (e opcionalmente por IP). Respostas **429** quando excedido.
- **Streaming relay**: o consumer deve emitir `relay:rpc.stream.pull` com `window_size` para conceder créditos; sem créditos, o hub pode **bufferizar** chunks ate um teto e depois encerrar o stream com `relay:rpc.complete` terminal (`terminal_status: "aborted"`).
- **REST vs Socket**: o REST **materializa** streams SQL num único JSON; para muitas linhas ou baixa latência por chunk, usar Socket (legado ou relay).
- **Multi-réplica**: correlação REST e muito estado do bridge são **por processo**; várias instâncias sem afinidade partilhada degradam o comportamento — ver `docs/scaling_and_roadmap.md`.

## Exemplo de encode/decode no cliente (Node.js)

Alinhado ao modo **automatico** do hub / plug_agente: acima do limiar (1024 bytes UTF-8), usar **gzip so se** o bloco comprimido economizar bytes suficientes face ao JSON bruto (ver `PAYLOAD_FRAME_AUTO_GZIP_MIN_SAVINGS_BYTES`); caso contrario `cmp: "none"`. (No REST/relay, `payloadFrameCompression: "always"` no envelope controla a re-encodacao **hub → agente** apos o servidor descodificar o teu frame.)

```ts
import { gzipSync, gunzipSync } from "node:zlib";

const COMPRESSION_THRESHOLD = 1024;

const encodeFrame = (data: unknown): PayloadFrame => {
  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  let cmp: "none" | "gzip" = "none";
  let wire: Buffer = encoded;
  if (encoded.length >= COMPRESSION_THRESHOLD) {
    const gz = gzipSync(encoded);
    if (gz.length < encoded.length) {
      wire = gz;
      cmp = "gzip";
    }
  }
  return {
    schemaVersion: "1.0",
    enc: "json",
    cmp,
    contentType: "application/json",
    originalSize: encoded.length,
    compressedSize: wire.length,
    payload: wire,
  };
};

const decodeFrame = (frame: PayloadFrame) => {
  const bytes =
    typeof frame.payload === "string"
      ? Buffer.from(frame.payload, "base64")
      : Buffer.from(frame.payload);
  const decoded = frame.cmp === "gzip" ? gunzipSync(bytes) : bytes;
  return JSON.parse(decoded.toString("utf8"));
};
```

**Producao:** o exemplo acima e didatico. Antes de `gunzip` / `JSON.parse`, um cliente robusto deve:
validar `enc === "json"` e `cmp` em `gzip` \| `none`; conferir `bytes.length === compressedSize`;
apos descompressao, `decoded.length === originalSize`; limitar tamanho maximo e **razao de inflacao** (ex.: 20x,
como o hub em `payload_frame.ts` / `decodePayloadFrame`); se existir `signature`, verificar HMAC com a chave
negociada (ver `plug_agente/docs/communication/socketio_client_binary_transport.md`). Encode reutilizavel:
[`docs/snippets/payload_frame_client_encode.ts`](snippets/payload_frame_client_encode.ts).

## Fluxo minimo (chat-like)

1. `relay:conversation.start` com `{ agentId }`
2. Recebe `relay:conversation.started` com `conversationId`
3. Envia `relay:rpc.request` com `{ conversationId, frame }` (opcional: `payloadFrameCompression`: `default` \| `none` \| `always` — `default` = auto: gzip ao agente so se menor que JSON bruto; `always` = sempre gzip quando elegivel, alinhado ao plug_agente)
4. Recebe `relay:rpc.accepted` (JSON)
5. Recebe dados (`relay:rpc.response`, `relay:rpc.chunk`, `relay:rpc.complete`) em `PayloadFrame`
6. Em streaming, envia `relay:rpc.stream.pull` com `{ conversationId, frame }`
7. Finaliza com `relay:conversation.end`

### Resposta de `relay:rpc.stream.pull`

O servidor responde em JSON e inclui o orçamento restante da janela quando o pull é aceite ou rejeitado:

```json
{
  "success": true,
  "conversationId": "conv-1",
  "requestId": "req-1",
  "streamId": "stream-1",
  "windowSize": 32,
  "rateLimit": {
    "remainingCredits": 768,
    "limit": 1000,
    "scope": "user"
  }
}
```

Em overload do namespace `/consumers`, ou quando a janela de créditos estoura, a resposta vem com `success: false`; no caso de rate-limit por créditos, `error.code = "RATE_LIMITED"` e o bloco `rateLimit` mostra o saldo remanescente.

## Observacoes importantes

- O `id` JSON-RPC do cliente vira `client_request_id` para idempotencia.
- O servidor gera `requestId` interno e devolve em `relay:rpc.accepted`.
- Em throughput alto, respeite backpressure com `relay:rpc.stream.pull`.
- O servidor aplica rate-limit por consumer em:
  - `relay:conversation.start`
  - `relay:rpc.request`

## Bridge de comandos (`agents:command` no `/consumers`)

Fora do relay, o mesmo namespace `/consumers` expoe **`agents:command`**, que encaminha JSON-RPC ao
agente via hub (PayloadFrame em `rpc:request` no `/agents`), com o mesmo caso de uso que
`POST /api/v1/agents/commands`.

**Paridade com o body REST (`AgentCommandRequest` / OpenAPI):** o payload validado e o mesmo
`agentCommandBodySchema`: `agentId`, `command` (objeto unico **ou** batch ate 32 itens), opcionais
`timeoutMs`, `pagination` (so `sql.execute` unico), `payloadFrameCompression` (`default` \| `none` \| `always`).
Tetos UTF-8 no JSON logico (`sql`, `params`, etc.) sao os **mesmos** que no REST; ver `docs/api_rest_bridge.md`
e descricoes em `swagger.ts`.

**Rate limit:** o `POST /api/v1/agents/commands` aplica limites por JWT `sub` (e opcionalmente por IP).
O evento **`agents:command`** usa os **mesmos** `REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS` e
`REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` por utilizador (`sub`); o contador e **independente** do HTTP (na
mesma janela podes consumir ate N por REST e ate N por Socket). Sockets sem `sub` usam chave por ligacao.
Metricas: `plug_socket_agents_command_rate_limit_*` em `/metrics`. O modo **relay** mantem quotas proprias
(`SOCKET_RELAY_RATE_LIMIT_*`).

Semantica do campo JSON-RPC **`id`** (alinhada ao REST):

| `id` no payload | Comportamento |
| ----------------- | ------------- |
| **omitido** | O servidor gera **UUID** e aguarda resposta; `agents:command_response` traz o resultado normalizado (como HTTP 200). |
| **`null`** | **Notification**: sem pending; resposta de aceitacao com tipo notification (como HTTP 202). |
| **string / number** | Correlacao explicita; repassado ao agente. |

**Diferenca em relacao ao plug_agente direto:** no socket direto ao agente, omitir `id` costuma ser
notification; no **hub plug_server** a omissao e preenchida para facilitar integracao. Detalhes:
`docs/api_rest_bridge.md` (secao *Hub vs agente direto*).

### Exemplo de body JSON (`agents:command`)

Espelha o mesmo objeto que enviarias no body do `POST /api/v1/agents/commands` (ver OpenAPI em
`agents.routes.ts` / Swagger). Resposta em `agents:command_response` (e chunks em
`agents:command_stream_chunk` / `agents:command_stream_complete` se houver stream).

```json
{
  "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
  "timeoutMs": 15000,
  "payloadFrameCompression": "default",
  "command": {
    "jsonrpc": "2.0",
    "method": "sql.execute",
    "id": "req-socket-1",
    "api_version": "2.5",
    "meta": {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
    },
    "params": {
      "sql": "SELECT 1",
      "client_token": "token-value",
      "options": {
        "execution_mode": "preserve"
      }
    }
  }
}
```

Batch: o campo `command` pode ser um **array** de ate 32 pedidos JSON-RPC (mesmas regras que o REST).
Paginacao no nivel do body: `pagination: { "page": 1, "pageSize": 100 }` apenas com `sql.execute` unico.

