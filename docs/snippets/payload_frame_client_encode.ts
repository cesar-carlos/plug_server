/**
 * Referencia: encode PayloadFrame alinhado ao modo gzip **automatico** do hub / plug_agente
 * (acima de 4096 B UTF-8, comprimir so se o gzip for menor que o JSON bruto
 * e nao violar a razao maxima de inflacao).
 * Copiar para o teu cliente ou extrair para um pacote interno.
 *
 * Ver tambem: docs/socket_client_sdk.md
 */
import { gzipSync, gunzipSync } from "node:zlib";

const COMPRESSION_THRESHOLD = 4096;
const MAX_INFLATION_RATIO = 10;

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
    if (gz.length < encoded.length && encoded.length / gz.length <= MAX_INFLATION_RATIO) {
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
  if (bytes.length > 0 && decoded.length / bytes.length > MAX_INFLATION_RATIO) {
    throw new Error("PayloadFrame inflation ratio exceeded");
  }
  return JSON.parse(decoded.toString("utf8")) as unknown;
}
