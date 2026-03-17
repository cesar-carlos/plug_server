# Socket Client SDK Minimo (Relay)

Data: 2026-03-17

Guia rapido para cliente Socket no modo relay (`/consumers`), com tratamento de
`PayloadFrame` binario + `gzip`.

## Eventos e formato

- Controle em JSON: `relay:conversation.*`, `relay:rpc.accepted`, `relay:rpc.stream.pull_response`
- Dados em `PayloadFrame`: `relay:rpc.request`, `relay:rpc.response`, `relay:rpc.chunk`, `relay:rpc.complete`, `relay:rpc.request_ack`, `relay:rpc.batch_ack`, `relay:rpc.stream.pull`

## Estrutura do PayloadFrame

```ts
type PayloadFrame = {
  schemaVersion: "1.0";
  enc: "json";
  cmp: "none" | "gzip";
  contentType: "application/json";
  originalSize: number;
  compressedSize: number;
  payload: Uint8Array | number[];
  traceId?: string;
  requestId?: string;
  signature?: { alg: "hmac-sha256"; value: string; key_id?: string };
};
```

## Exemplo de encode/decode no cliente (Node.js)

```ts
import { gzipSync, gunzipSync } from "node:zlib";

const encodeFrame = (data: unknown): PayloadFrame => {
  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  const shouldGzip = encoded.length >= 1024;
  const wire = shouldGzip ? gzipSync(encoded) : encoded;
  return {
    schemaVersion: "1.0",
    enc: "json",
    cmp: shouldGzip ? "gzip" : "none",
    contentType: "application/json",
    originalSize: encoded.length,
    compressedSize: wire.length,
    payload: wire,
  };
};

const decodeFrame = (frame: PayloadFrame) => {
  const bytes = Buffer.from(frame.payload);
  const decoded = frame.cmp === "gzip" ? gunzipSync(bytes) : bytes;
  return JSON.parse(decoded.toString("utf8"));
};
```

## Fluxo minimo (chat-like)

1. `relay:conversation.start` com `{ agentId }`
2. Recebe `relay:conversation.started` com `conversationId`
3. Envia `relay:rpc.request` com `{ conversationId, frame }`
4. Recebe `relay:rpc.accepted` (JSON)
5. Recebe dados (`relay:rpc.response`, `relay:rpc.chunk`, `relay:rpc.complete`) em `PayloadFrame`
6. Em streaming, envia `relay:rpc.stream.pull` com `{ conversationId, frame }`
7. Finaliza com `relay:conversation.end`

## Observacoes importantes

- O `id` JSON-RPC do cliente vira `client_request_id` para idempotencia.
- O servidor gera `requestId` interno e devolve em `relay:rpc.accepted`.
- Em throughput alto, respeite backpressure com `relay:rpc.stream.pull`.
- O servidor aplica rate-limit por consumer em:
  - `relay:conversation.start`
  - `relay:rpc.request`

