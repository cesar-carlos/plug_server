import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { env } from "../config/env";
import type { Result } from "../errors/result";
import { err, ok } from "../errors/result";
import { badRequest } from "../errors/http_errors";

const defaultCompressionThreshold = 1024;
const maxCompressedPayloadBytes = 10 * 1024 * 1024;
const maxDecodedPayloadBytes = 10 * 1024 * 1024;
const maxInflationRatio = 20;

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

interface SignatureEnvelope {
  readonly alg: string;
  readonly value: string;
  readonly key_id?: string;
}

const toSignatureEnvelope = (value: unknown): SignatureEnvelope | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<SignatureEnvelope>;
  if (typeof candidate.alg !== "string" || typeof candidate.value !== "string") {
    return null;
  }

  if (candidate.key_id !== undefined && typeof candidate.key_id !== "string") {
    return null;
  }

  return {
    alg: candidate.alg,
    value: candidate.value,
    ...(candidate.key_id !== undefined ? { key_id: candidate.key_id } : {}),
  };
};

const buildSignatureInput = (frame: PayloadFrameEnvelope, binaryPayload: Buffer): Buffer => {
  const metadata = JSON.stringify({
    schemaVersion: frame.schemaVersion,
    enc: frame.enc,
    cmp: frame.cmp,
    contentType: frame.contentType,
    originalSize: frame.originalSize,
    compressedSize: frame.compressedSize,
    traceId: frame.traceId ?? null,
    requestId: frame.requestId ?? null,
  });

  return Buffer.concat([Buffer.from(metadata, "utf8"), Buffer.from([0]), binaryPayload]);
};

const validateFrameSignature = (
  frame: PayloadFrameEnvelope,
  binaryPayload: Buffer,
): Result<void> => {
  if (frame.signature === undefined) {
    return ok(undefined);
  }

  const signature = toSignatureEnvelope(frame.signature);
  if (!signature) {
    return err(badRequest("PayloadFrame signature is invalid"));
  }

  if (signature.alg !== "hmac-sha256") {
    return err(badRequest("Unsupported PayloadFrame signature algorithm"));
  }

  if (!env.payloadSigningKey || env.payloadSigningKey.trim() === "") {
    return err(badRequest("PayloadFrame signature provided but PAYLOAD_SIGNING_KEY is not configured"));
  }

  if (
    env.payloadSigningKeyId &&
    signature.key_id &&
    signature.key_id.trim() !== "" &&
    signature.key_id !== env.payloadSigningKeyId
  ) {
    return err(badRequest("PayloadFrame signature key_id mismatch"));
  }

  const expectedSignature = createHmac("sha256", env.payloadSigningKey)
    .update(buildSignatureInput(frame, binaryPayload))
    .digest("base64");

  const providedSignature = signature.value.trim();
  if (providedSignature === "") {
    return err(badRequest("PayloadFrame signature value is empty"));
  }

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const providedBuffer = Buffer.from(providedSignature, "utf8");

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return err(badRequest("PayloadFrame signature verification failed"));
  }

  return ok(undefined);
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

  if (payload.compressedSize > maxCompressedPayloadBytes || binaryPayload.length > maxCompressedPayloadBytes) {
    return err(badRequest("PayloadFrame compressed payload exceeds limit"));
  }

  if (binaryPayload.length !== payload.compressedSize) {
    return err(badRequest("PayloadFrame compressed size mismatch"));
  }

  const signatureValidation = validateFrameSignature(payload, binaryPayload);
  if (!signatureValidation.ok) {
    return signatureValidation;
  }

  let decodedBytes: Buffer;
  try {
    decodedBytes = payload.cmp === "gzip" ? gunzipSync(binaryPayload) : binaryPayload;
  } catch {
    return err(badRequest("Failed to decompress PayloadFrame payload"));
  }

  if (decodedBytes.length > maxDecodedPayloadBytes || payload.originalSize > maxDecodedPayloadBytes) {
    return err(badRequest("PayloadFrame decoded payload exceeds limit"));
  }

  if (
    payload.cmp === "gzip" &&
    binaryPayload.length > 0 &&
    decodedBytes.length / binaryPayload.length > maxInflationRatio
  ) {
    return err(badRequest("PayloadFrame inflation ratio exceeds limit"));
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
