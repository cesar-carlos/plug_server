/**
 * Referencia: encode PayloadFrame alinhado ao modo gzip **automatico** do hub / plug_agente
 * (acima de 1024 B UTF-8, comprimir so se o gzip for menor que o JSON bruto).
 * Copiar para o teu cliente ou extrair para um pacote interno.
 *
 * Ver tambem: docs/socket_client_sdk.md
 */
import { gzipSync, gunzipSync } from "node:zlib";

const COMPRESSION_THRESHOLD = 1024;

export type PayloadFrame = {
  schemaVersion: "1.0";
  enc: "json";
  cmp: "none" | "gzip";
  contentType: "application/json";
  originalSize: number;
  compressedSize: number;
  payload: Uint8Array | Buffer | number[];
};

export function encodePayloadFrameAuto(data: unknown): PayloadFrame {
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
}

export function decodePayloadFrameJson(frame: PayloadFrame): unknown {
  const bytes = Buffer.from(frame.payload as Buffer);
  const decoded = frame.cmp === "gzip" ? gunzipSync(bytes) : bytes;
  return JSON.parse(decoded.toString("utf8")) as unknown;
}
