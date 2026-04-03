import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { gunzip as zlibGunzip, gunzipSync, gzip as zlibGzip, gzipSync } from "node:zlib";

import { env } from "../config/env";
import type { Result } from "../errors/result";
import { err, ok } from "../errors/result";
import { badRequest } from "../errors/http_errors";

const defaultCompressionThreshold = 1024;

const gzipAsync = promisify(zlibGzip);
const gunzipAsync = promisify(zlibGunzip);
const EMPTY_BUFFER = Buffer.alloc(0);

/** Hub → agent PayloadFrame gzip policy (see `payloadFrameEncodeOptionsFromPreference`). */
export type PayloadFrameCompressionPreference = "default" | "none" | "always";

/**
 * Aligned with plug_agente `OutboundCompressionMode`:
 * - `auto`: above threshold, gzip only if strictly smaller than raw UTF-8.
 * - `always_gzip`: above threshold, always gzip (even if larger).
 */
export type PayloadFrameOutboundCompressionPolicy = "auto" | "always_gzip";

export interface PreencodePayloadFrameJsonOptions {
  readonly compressionThreshold?: number;
  readonly compressionPolicy?: PayloadFrameOutboundCompressionPolicy;
  /** Override max UTF-8 length eligible for gzip attempt (default: `env.payloadFrameMaxGzipInputBytes`). */
  readonly maxGzipInputBytes?: number;
}

/**
 * Maps API `payloadFrameCompression` to `encodePayloadFrame` options.
 * - `default` / `undefined`: threshold 1024, policy **auto** (gzip only if smaller than raw JSON).
 * - `none`: never gzip.
 * - `always`: threshold 1, policy **always_gzip** (matches agent "sempre GZIP").
 */
export const payloadFrameEncodeOptionsFromPreference = (
  preference: PayloadFrameCompressionPreference | undefined,
): PreencodePayloadFrameJsonOptions => {
  if (preference === undefined || preference === "default") {
    return {};
  }
  if (preference === "none") {
    return { compressionThreshold: Number.POSITIVE_INFINITY };
  }
  return { compressionThreshold: 1, compressionPolicy: "always_gzip" };
};
const maxCompressedPayloadBytes = 10 * 1024 * 1024;
const maxDecodedPayloadBytes = 10 * 1024 * 1024;
const maxInflationRatio = 20;

/** Aligned with `plug_agente` `docs/communication/schemas/payload-frame.schema.json`. */
export const PAYLOAD_FRAME_SCHEMA_VERSION = "1.0" as const;

const PAYLOAD_FRAME_ALLOWED_ROOT_KEYS = new Set([
  "schemaVersion",
  "enc",
  "cmp",
  "contentType",
  "originalSize",
  "compressedSize",
  "payload",
  "traceId",
  "requestId",
  "signature",
]);

const PAYLOAD_FRAME_SIGNATURE_KEYS = new Set(["alg", "value", "key_id"]);

const isNonNegativeInteger = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && Number.isFinite(n) && n >= 0;

const isValidPayloadFrameSignatureBlock = (sig: unknown): boolean => {
  if (typeof sig !== "object" || sig === null) {
    return false;
  }
  const o = sig as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!PAYLOAD_FRAME_SIGNATURE_KEYS.has(k)) {
      return false;
    }
  }
  if (o.alg !== "hmac-sha256" || typeof o.value !== "string") {
    return false;
  }
  if (o.key_id !== undefined && typeof o.key_id !== "string") {
    return false;
  }
  return true;
};

export interface PayloadFrameEnvelope {
  readonly schemaVersion: typeof PAYLOAD_FRAME_SCHEMA_VERSION;
  readonly enc: "json";
  readonly cmp: "none" | "gzip";
  readonly contentType: "application/json";
  readonly originalSize: number;
  readonly compressedSize: number;
  readonly payload: Buffer | Uint8Array | readonly number[] | string;
  readonly traceId?: string;
  /** JSON-RPC envelope may use `null` id (per JSON Schema `requestId` on the transport frame). */
  readonly requestId?: string | null;
  readonly signature?: Record<string, unknown>;
}

export interface DecodedPayloadFrame {
  readonly frame: PayloadFrameEnvelope;
  readonly data: unknown;
}

const toBufferFromReadonlyNumberArray = (payload: readonly number[]): Buffer | null => {
  const len = payload.length;
  if (len === 0) {
    return EMPTY_BUFFER;
  }

  const binary = Buffer.allocUnsafe(len);
  for (let index = 0; index < len; index += 1) {
    const value = payload[index];
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    binary[index] = value;
  }
  return binary;
};

const toBuffer = (payload: PayloadFrameEnvelope["payload"] | unknown): Buffer | null => {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }

  if (Array.isArray(payload)) {
    return toBufferFromReadonlyNumberArray(payload);
  }

  if (typeof payload === "string") {
    try {
      return Buffer.from(payload, "base64");
    } catch {
      return null;
    }
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

const signOutboundFrameIfConfigured = (
  frame: PayloadFrameEnvelope,
  binaryPayloadOverride?: Buffer,
): PayloadFrameEnvelope => {
  if (!env.payloadSignOutbound || !env.payloadSigningKey || env.payloadSigningKey.trim() === "") {
    return frame;
  }

  const binaryPayload = binaryPayloadOverride ?? toBuffer(frame.payload);
  if (!binaryPayload) {
    return frame;
  }

  const value = createHmac("sha256", env.payloadSigningKey)
    .update(buildSignatureInput(frame, binaryPayload))
    .digest("base64");

  return {
    ...frame,
    signature: {
      alg: "hmac-sha256",
      value,
      ...(env.payloadSigningKeyId && env.payloadSigningKeyId.trim() !== ""
        ? { key_id: env.payloadSigningKeyId }
        : {}),
    },
  };
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
    return err(
      badRequest("PayloadFrame signature provided but PAYLOAD_SIGNING_KEY is not configured"),
    );
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

/**
 * Structural validation aligned with plug_agente `payload-frame.schema.json`:
 * `schemaVersion` 1.0, `enc` json, `cmp` none|gzip, `contentType` application/json,
 * non-negative integer sizes, no unknown root keys; optional `signature` only with
 * `alg`/`value`/`key_id` (hub may omit `key_id` when signing without `PAYLOAD_SIGNING_KEY_ID`).
 */
export const isPayloadFrameEnvelope = (payload: unknown): payload is PayloadFrameEnvelope => {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!PAYLOAD_FRAME_ALLOWED_ROOT_KEYS.has(key)) {
      return false;
    }
  }

  if (
    candidate.schemaVersion !== PAYLOAD_FRAME_SCHEMA_VERSION ||
    candidate.enc !== "json" ||
    (candidate.cmp !== "none" && candidate.cmp !== "gzip") ||
    candidate.contentType !== "application/json" ||
    !isNonNegativeInteger(candidate.originalSize) ||
    !isNonNegativeInteger(candidate.compressedSize) ||
    !("payload" in candidate)
  ) {
    return false;
  }

  const traceId = candidate.traceId;
  if (traceId !== undefined && typeof traceId !== "string") {
    return false;
  }

  const requestId = candidate.requestId;
  if (requestId !== undefined && requestId !== null && typeof requestId !== "string") {
    return false;
  }

  if (
    candidate.signature !== undefined &&
    !isValidPayloadFrameSignatureBlock(candidate.signature)
  ) {
    return false;
  }

  return true;
};

/** JSON body encoded once; reuse with `finishPayloadFrameEnvelope` for multiple frames (e.g. batch ack). */
export interface PreencodedPayloadFrameBody {
  readonly originalSize: number;
  readonly wireBytes: Buffer;
  readonly cmp: "none" | "gzip";
}

const normalizePreencodeOptions = (
  options?: number | PreencodePayloadFrameJsonOptions,
): PreencodePayloadFrameJsonOptions => {
  if (typeof options === "number") {
    return { compressionThreshold: options };
  }
  return options ?? {};
};

const preencodeUtf8Buffer = (
  encoded: Buffer,
  opts: PreencodePayloadFrameJsonOptions,
): PreencodedPayloadFrameBody => {
  const threshold = opts.compressionThreshold ?? defaultCompressionThreshold;
  const policy = opts.compressionPolicy ?? "auto";
  const maxGzipInputBytes = opts.maxGzipInputBytes ?? env.payloadFrameMaxGzipInputBytes;

  const belowThreshold = encoded.length < threshold;
  const aboveMaxInput = encoded.length > maxGzipInputBytes;
  if (belowThreshold || aboveMaxInput || threshold === Number.POSITIVE_INFINITY) {
    return {
      originalSize: encoded.length,
      wireBytes: encoded,
      cmp: "none",
    };
  }

  const gzipLevel = env.payloadFrameGzipLevel;
  const minSavingsBytes = env.payloadFrameAutoGzipMinSavingsBytes;
  const compressed =
    gzipLevel !== undefined ? gzipSync(encoded, { level: gzipLevel }) : gzipSync(encoded);
  if (policy === "always_gzip") {
    return {
      originalSize: encoded.length,
      wireBytes: compressed,
      cmp: "gzip",
    };
  }

  if (encoded.length - compressed.length >= minSavingsBytes) {
    return {
      originalSize: encoded.length,
      wireBytes: compressed,
      cmp: "gzip",
    };
  }

  return {
    originalSize: encoded.length,
    wireBytes: encoded,
    cmp: "none",
  };
};

const preencodeUtf8BufferAsync = async (
  encoded: Buffer,
  opts: PreencodePayloadFrameJsonOptions,
): Promise<PreencodedPayloadFrameBody> => {
  const threshold = opts.compressionThreshold ?? defaultCompressionThreshold;
  const policy = opts.compressionPolicy ?? "auto";
  const maxGzipInputBytes = opts.maxGzipInputBytes ?? env.payloadFrameMaxGzipInputBytes;

  const belowThreshold = encoded.length < threshold;
  const aboveMaxInput = encoded.length > maxGzipInputBytes;
  if (belowThreshold || aboveMaxInput || threshold === Number.POSITIVE_INFINITY) {
    return {
      originalSize: encoded.length,
      wireBytes: encoded,
      cmp: "none",
    };
  }

  const gzipLevel = env.payloadFrameGzipLevel;
  const minSavingsBytes = env.payloadFrameAutoGzipMinSavingsBytes;
  const zlibOpts = gzipLevel !== undefined ? { level: gzipLevel } : {};
  const compressed = await gzipAsync(encoded, zlibOpts);
  if (policy === "always_gzip") {
    return {
      originalSize: encoded.length,
      wireBytes: compressed,
      cmp: "gzip",
    };
  }

  if (encoded.length - compressed.length >= minSavingsBytes) {
    return {
      originalSize: encoded.length,
      wireBytes: compressed,
      cmp: "gzip",
    };
  }

  return {
    originalSize: encoded.length,
    wireBytes: encoded,
    cmp: "none",
  };
};

export const preencodePayloadFrameJson = (
  data: unknown,
  options?: number | PreencodePayloadFrameJsonOptions,
): PreencodedPayloadFrameBody => {
  const opts = normalizePreencodeOptions(options);
  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  return preencodeUtf8Buffer(encoded, opts);
};

export const finishPayloadFrameEnvelope = (
  body: PreencodedPayloadFrameBody,
  options?: {
    readonly requestId?: string;
    readonly traceId?: string;
    /** Skip traceId on the envelope (saves UUID work on high-frequency stream paths; use requestId for correlation). */
    readonly omitTraceId?: boolean;
  },
): PayloadFrameEnvelope => {
  const traceFields =
    options?.traceId !== undefined
      ? { traceId: options.traceId }
      : options?.omitTraceId === true
        ? {}
        : { traceId: randomUUID() };

  return signOutboundFrameIfConfigured(
    {
      schemaVersion: PAYLOAD_FRAME_SCHEMA_VERSION,
      enc: "json",
      cmp: body.cmp,
      contentType: "application/json",
      originalSize: body.originalSize,
      compressedSize: body.wireBytes.length,
      payload: body.wireBytes,
      ...traceFields,
      ...(options?.requestId ? { requestId: options.requestId } : {}),
    },
    body.wireBytes,
  );
};

export type EncodePayloadFrameOptions = {
  readonly compressionThreshold?: number;
  readonly compressionPolicy?: PayloadFrameOutboundCompressionPolicy;
  readonly maxGzipInputBytes?: number;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly omitTraceId?: boolean;
  /**
   * Override `env.payloadFrameAsyncGzipMinUtf8Bytes`. When > 0 and the payload is eligible for gzip,
   * uses async zlib (thread pool) instead of `gzipSync` for frames at least this many UTF-8 bytes.
   */
  readonly asyncGzipMinUtf8Bytes?: number;
};

export const encodePayloadFrame = (
  data: unknown,
  options?: EncodePayloadFrameOptions,
): PayloadFrameEnvelope => {
  const body = preencodePayloadFrameJson(data, {
    ...(options?.compressionThreshold !== undefined
      ? { compressionThreshold: options.compressionThreshold }
      : {}),
    ...(options?.compressionPolicy !== undefined
      ? { compressionPolicy: options.compressionPolicy }
      : {}),
    ...(options?.maxGzipInputBytes !== undefined
      ? { maxGzipInputBytes: options.maxGzipInputBytes }
      : {}),
  });
  return finishPayloadFrameEnvelope(body, options);
};

/**
 * Hub bridge helper: one `JSON.stringify`, optional async gzip for large eligible payloads
 * (see `PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES`), then envelope.
 */
export const encodePayloadFrameBridge = async (
  data: unknown,
  options?: EncodePayloadFrameOptions,
): Promise<PayloadFrameEnvelope> => {
  const minAsync = options?.asyncGzipMinUtf8Bytes ?? env.payloadFrameAsyncGzipMinUtf8Bytes;
  if (minAsync <= 0) {
    return encodePayloadFrame(data, options);
  }

  const preOpts: PreencodePayloadFrameJsonOptions = {
    ...(options?.compressionThreshold !== undefined
      ? { compressionThreshold: options.compressionThreshold }
      : {}),
    ...(options?.compressionPolicy !== undefined
      ? { compressionPolicy: options.compressionPolicy }
      : {}),
    ...(options?.maxGzipInputBytes !== undefined
      ? { maxGzipInputBytes: options.maxGzipInputBytes }
      : {}),
  };

  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  const threshold = preOpts.compressionThreshold ?? defaultCompressionThreshold;
  const maxGzipInputBytes = preOpts.maxGzipInputBytes ?? env.payloadFrameMaxGzipInputBytes;
  const belowThreshold = encoded.length < threshold;
  const aboveMaxInput = encoded.length > maxGzipInputBytes;
  const gzipEligible = !belowThreshold && !aboveMaxInput && threshold !== Number.POSITIVE_INFINITY;

  const body =
    gzipEligible && encoded.length >= minAsync
      ? await preencodeUtf8BufferAsync(encoded, preOpts)
      : preencodeUtf8Buffer(encoded, preOpts);

  return finishPayloadFrameEnvelope(body, {
    ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
    ...(options?.traceId !== undefined ? { traceId: options.traceId } : {}),
    ...(options?.omitTraceId === true ? { omitTraceId: true as const } : {}),
  });
};

const validatePayloadFrameForDecode = (
  payload: unknown,
): Result<{ readonly envelope: PayloadFrameEnvelope; readonly binaryPayload: Buffer }> => {
  if (!isPayloadFrameEnvelope(payload)) {
    return err(badRequest("Socket payload must be a valid PayloadFrame"));
  }

  const binaryPayload = toBuffer(payload.payload);
  if (binaryPayload === null) {
    return err(badRequest("PayloadFrame payload must contain binary data"));
  }

  if (
    payload.compressedSize > maxCompressedPayloadBytes ||
    binaryPayload.length > maxCompressedPayloadBytes
  ) {
    return err(badRequest("PayloadFrame compressed payload exceeds limit"));
  }

  if (binaryPayload.length !== payload.compressedSize) {
    return err(badRequest("PayloadFrame compressed size mismatch"));
  }

  const signatureValidation = validateFrameSignature(payload, binaryPayload);
  if (!signatureValidation.ok) {
    return signatureValidation;
  }

  return ok({ envelope: payload, binaryPayload });
};

const finalizeDecodedPayloadBytes = (
  envelope: PayloadFrameEnvelope,
  binaryPayload: Buffer,
  decodedBytes: Buffer,
): Result<DecodedPayloadFrame> => {
  if (
    decodedBytes.length > maxDecodedPayloadBytes ||
    envelope.originalSize > maxDecodedPayloadBytes
  ) {
    return err(badRequest("PayloadFrame decoded payload exceeds limit"));
  }

  if (
    envelope.cmp === "gzip" &&
    binaryPayload.length > 0 &&
    decodedBytes.length / binaryPayload.length > maxInflationRatio
  ) {
    return err(badRequest("PayloadFrame inflation ratio exceeds limit"));
  }

  if (decodedBytes.length !== envelope.originalSize) {
    return err(badRequest("PayloadFrame original size mismatch"));
  }

  try {
    const decoded = JSON.parse(decodedBytes.toString("utf8"));
    const normalizedEnvelope =
      envelope.payload === binaryPayload ? envelope : { ...envelope, payload: binaryPayload };
    return ok({
      frame: normalizedEnvelope,
      data: decoded,
    });
  } catch {
    return err(badRequest("Failed to decode PayloadFrame JSON payload"));
  }
};

const decompressPayloadFrameSync = (
  envelope: PayloadFrameEnvelope,
  binaryPayload: Buffer,
): Result<Buffer> => {
  try {
    return ok(envelope.cmp === "gzip" ? gunzipSync(binaryPayload) : binaryPayload);
  } catch {
    return err(badRequest("Failed to decompress PayloadFrame payload"));
  }
};

export const decodePayloadFrame = (payload: unknown): Result<DecodedPayloadFrame> => {
  const prep = validatePayloadFrameForDecode(payload);
  if (!prep.ok) {
    return prep;
  }

  const { envelope, binaryPayload } = prep.value;
  const decompressed = decompressPayloadFrameSync(envelope, binaryPayload);
  if (!decompressed.ok) {
    return decompressed;
  }

  return finalizeDecodedPayloadBytes(envelope, binaryPayload, decompressed.value);
};

/**
 * Same as `decodePayloadFrame` but uses async zlib gunzip for large **compressed** payloads when
 * `PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES` is set (> 0) and `cmp === "gzip"`.
 */
export const decodePayloadFrameAsync = async (
  payload: unknown,
): Promise<Result<DecodedPayloadFrame>> => {
  const prep = validatePayloadFrameForDecode(payload);
  if (!prep.ok) {
    return prep;
  }

  const { envelope, binaryPayload } = prep.value;
  const minAsync = env.payloadFrameAsyncGunzipMinCompressedBytes;
  let decodedBytes: Buffer;
  try {
    if (envelope.cmp === "gzip") {
      if (minAsync > 0 && binaryPayload.length >= minAsync) {
        decodedBytes = await gunzipAsync(binaryPayload);
      } else {
        decodedBytes = gunzipSync(binaryPayload);
      }
    } else {
      decodedBytes = binaryPayload;
    }
  } catch {
    return err(badRequest("Failed to decompress PayloadFrame payload"));
  }

  return finalizeDecodedPayloadBytes(envelope, binaryPayload, decodedBytes);
};
