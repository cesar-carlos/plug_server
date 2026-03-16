import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type { Result } from "../errors/result";
import { err, ok } from "../errors/result";
import { badRequest } from "../errors/http_errors";

const defaultCompressionThreshold = 1024;

export interface PayloadFrameEnvelope {
  readonly schemaVersion: string;
  readonly enc: "json";
  readonly cmp: "none" | "gzip";
  readonly contentType: "application/json";
  readonly originalSize: number;
  readonly compressedSize: number;
  readonly payload: Buffer | Uint8Array | readonly number[];
  readonly traceId?: string;
  readonly requestId?: string;
  readonly signature?: Record<string, unknown>;
}

export interface DecodedPayloadFrame {
  readonly frame: PayloadFrameEnvelope;
  readonly data: unknown;
}

const toBuffer = (payload: PayloadFrameEnvelope["payload"] | unknown): Buffer | null => {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }

  if (Array.isArray(payload) && payload.every((item) => typeof item === "number")) {
    return Buffer.from(payload);
  }

  return null;
};

export const isPayloadFrameEnvelope = (payload: unknown): payload is PayloadFrameEnvelope => {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const candidate = payload as Partial<PayloadFrameEnvelope>;
  return (
    typeof candidate.schemaVersion === "string" &&
    candidate.enc === "json" &&
    (candidate.cmp === "none" || candidate.cmp === "gzip") &&
    typeof candidate.originalSize === "number" &&
    typeof candidate.compressedSize === "number" &&
    "payload" in candidate
  );
};

export const encodePayloadFrame = (
  data: unknown,
  options?: {
    readonly compressionThreshold?: number;
    readonly requestId?: string;
    readonly traceId?: string;
  },
): PayloadFrameEnvelope => {
  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  const threshold = options?.compressionThreshold ?? defaultCompressionThreshold;
  const shouldCompress = encoded.length >= threshold;
  const wireBytes = shouldCompress ? gzipSync(encoded) : encoded;

  return {
    schemaVersion: "1.0",
    enc: "json",
    cmp: shouldCompress ? "gzip" : "none",
    contentType: "application/json",
    originalSize: encoded.length,
    compressedSize: wireBytes.length,
    payload: wireBytes,
    ...(options?.traceId ? { traceId: options.traceId } : { traceId: randomUUID() }),
    ...(options?.requestId ? { requestId: options.requestId } : {}),
  };
};

export const decodePayloadFrame = (payload: unknown): Result<DecodedPayloadFrame> => {
  if (!isPayloadFrameEnvelope(payload)) {
    return err(badRequest("Socket payload must be a valid PayloadFrame"));
  }

  const binaryPayload = toBuffer(payload.payload);
  if (binaryPayload === null) {
    return err(badRequest("PayloadFrame payload must contain binary data"));
  }

  if (binaryPayload.length !== payload.compressedSize) {
    return err(badRequest("PayloadFrame compressed size mismatch"));
  }

  let decodedBytes: Buffer;
  try {
    decodedBytes = payload.cmp === "gzip" ? gunzipSync(binaryPayload) : binaryPayload;
  } catch {
    return err(badRequest("Failed to decompress PayloadFrame payload"));
  }

  if (decodedBytes.length !== payload.originalSize) {
    return err(badRequest("PayloadFrame original size mismatch"));
  }

  try {
    const decoded = JSON.parse(decodedBytes.toString("utf8"));
    return ok({
      frame: {
        ...payload,
        payload: binaryPayload,
      },
      data: decoded,
    });
  } catch {
    return err(badRequest("Failed to decode PayloadFrame JSON payload"));
  }
};
