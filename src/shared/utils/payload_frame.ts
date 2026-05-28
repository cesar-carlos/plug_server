import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { gunzip as zlibGunzip, gunzipSync, gzip as zlibGzip, gzipSync } from "node:zlib";

import { env } from "../config/env";
import {
  HUB_PAYLOAD_FRAME_COMPRESSION_THRESHOLD_BYTES,
  HUB_PAYLOAD_FRAME_MAX_INFLATION_RATIO,
} from "../constants/agent_transport_contract";
import type { Result } from "../errors/result";
import { err, ok } from "../errors/result";
import { badRequest } from "../errors/http_errors";
import {
  notePayloadFrameSignatureAccepted,
  notePayloadFrameSignatureRejected,
  type PayloadFrameSignatureAcceptedKeyKind,
  type PayloadFrameSignatureRejectReason,
} from "../metrics/payload_frame.metrics";

const defaultCompressionThreshold = HUB_PAYLOAD_FRAME_COMPRESSION_THRESHOLD_BYTES;

/** Applies `PAYLOAD_FRAME_COMPRESS_MIN_BYTES` for standard hub encoders (see encodePayloadFrame). */
const effectiveEncodeCompressionThreshold = (
  explicit: number | undefined,
  serializedUtf8Length: number,
): number => {
  if (explicit === Number.POSITIVE_INFINITY) {
    return explicit;
  }
  const globalMin = env.payloadFrameCompressMinBytes;
  if (serializedUtf8Length < globalMin) {
    return Number.POSITIVE_INFINITY;
  }
  return explicit ?? globalMin;
};

const gzipAsync = promisify(zlibGzip);
const gunzipAsync = promisify(zlibGunzip);
const EMPTY_BUFFER = Buffer.alloc(0);

/** Hub → agent PayloadFrame gzip policy (see `payloadFrameEncodeOptionsFromPreference`). */
export type PayloadFrameCompressionPreference = "default" | "none" | "always";

/**
 * Aligned with plug_agente `OutboundCompressionMode`:
 * - `auto`: above threshold, gzip only if strictly smaller than raw UTF-8.
 * - `always_gzip`: above threshold, prefer gzip even if larger, but never emit
 *   a frame that exceeds the negotiated inflation-ratio guard.
 */
export type PayloadFrameOutboundCompressionPolicy = "auto" | "always_gzip";

export interface PreencodePayloadFrameJsonOptions {
  readonly compressionThreshold?: number;
  readonly compressionPolicy?: PayloadFrameOutboundCompressionPolicy;
  readonly maxInflationRatio?: number;
  /** Override max UTF-8 length eligible for gzip attempt (default: `env.payloadFrameMaxGzipInputBytes`). */
  readonly maxGzipInputBytes?: number;
}

/**
 * Maps API `payloadFrameCompression` to `encodePayloadFrame` options.
 * - `default` / `undefined`: threshold 4096, policy **auto** (gzip only if smaller than raw JSON).
 * - `none`: never gzip.
 * - `always`: threshold 1, policy **always_gzip** (matches agent "sempre GZIP",
 *   bounded by the inflation-ratio guard).
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
const maxInflationRatio = HUB_PAYLOAD_FRAME_MAX_INFLATION_RATIO;

const exceedsMaxInflationRatio = (
  originalSize: number,
  compressedSize: number,
  ratioLimit: number,
): boolean => compressedSize > 0 && originalSize / compressedSize > ratioLimit;

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

/**
 * Structural shape check for the signature block. `key_id` is required by the
 * upstream `payload-frame.schema.json`, but the hub also accepts signatures
 * without `key_id` for legacy compatibility (see comment on
 * `isPayloadFrameEnvelope`). Cryptographic enforcement of `key_id` happens in
 * `validateFrameSignature` once the configured signing key id is known.
 */
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
  /**
   * UTF-8 JSON bytes of the decompressed payload. Same content as
   * `JSON.stringify(data)` for the same shape but **without** the cost of a
   * re-stringify on the forwarder hot path — see `encodePayloadFrameFromBytes`.
   *
   * Callers that need to forward the payload **as-is** (no mutation of
   * `data`) should prefer reading these bytes over re-encoding `data` because
   * the bytes were already produced by the source's serializer and validated
   * by `finalizeDecodedPayloadBytes` (size cap + inflation guard).
   */
  readonly decodedBytes: Buffer;
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

interface PayloadFrameSigningKey {
  readonly secret: string;
  readonly kind: PayloadFrameSignatureAcceptedKeyKind;
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

const canonicalJsonStringify = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key] ?? null)}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value ?? null);
};

const buildSignatureInput = (frame: PayloadFrameEnvelope, binaryPayload: Buffer): Buffer => {
  const canonicalFrame = canonicalJsonStringify({
    schemaVersion: frame.schemaVersion,
    enc: frame.enc,
    cmp: frame.cmp,
    contentType: frame.contentType,
    originalSize: frame.originalSize,
    compressedSize: frame.compressedSize,
    traceId: frame.traceId ?? null,
    requestId: frame.requestId ?? null,
    payload: binaryPayload.toString("base64"),
  });

  return Buffer.from(canonicalFrame, "utf8");
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

const rejectSignature = (
  message: string,
  reason: PayloadFrameSignatureRejectReason,
): Result<never> => {
  notePayloadFrameSignatureRejected(reason);
  return err(badRequest(message));
};

const resolveSignatureVerificationKey = (
  signature: SignatureEnvelope,
): Result<PayloadFrameSigningKey> => {
  const activeKey =
    env.payloadSigningKey && env.payloadSigningKey.trim() !== "" ? env.payloadSigningKey : null;
  const activeKeyId =
    env.payloadSigningKeyId && env.payloadSigningKeyId.trim() !== ""
      ? env.payloadSigningKeyId.trim()
      : null;
  const previousKeys = env.payloadSigningPreviousKeys;
  const hasPreviousKeys = Object.keys(previousKeys).length > 0;

  if (signature.key_id !== undefined && signature.key_id.trim() !== "") {
    const keyId = signature.key_id.trim();
    if (activeKey !== null && activeKeyId !== null && keyId === activeKeyId) {
      return ok({ secret: activeKey, kind: "active" });
    }

    const previousKey = previousKeys[keyId];
    if (previousKey !== undefined && previousKey.trim() !== "") {
      return ok({ secret: previousKey, kind: "previous" });
    }

    return rejectSignature("PayloadFrame signature key_id is not recognized", "unknown_key_id");
  }

  if (activeKeyId !== null || hasPreviousKeys) {
    return rejectSignature(
      "PayloadFrame signature is missing key_id but key rotation is configured",
      "missing_key_id",
    );
  }

  if (activeKey !== null) {
    return ok({ secret: activeKey, kind: "single_key" });
  }

  return rejectSignature(
    "PayloadFrame signature provided but no signing key is configured",
    "no_key_configured",
  );
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
    return rejectSignature("PayloadFrame signature is invalid", "invalid_block");
  }

  if (signature.alg !== "hmac-sha256") {
    return rejectSignature("Unsupported PayloadFrame signature algorithm", "unsupported_alg");
  }

  const resolvedKey = resolveSignatureVerificationKey(signature);
  if (!resolvedKey.ok) {
    return resolvedKey;
  }

  const expectedSignature = createHmac("sha256", resolvedKey.value.secret)
    .update(buildSignatureInput(frame, binaryPayload))
    .digest("base64");

  const providedSignature = signature.value.trim();
  if (providedSignature === "") {
    return rejectSignature("PayloadFrame signature value is empty", "empty_value");
  }

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const providedBuffer = Buffer.from(providedSignature, "utf8");

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return rejectSignature("PayloadFrame signature verification failed", "invalid_signature");
  }

  notePayloadFrameSignatureAccepted(resolvedKey.value.kind);
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
  const inflationRatioLimit = opts.maxInflationRatio ?? maxInflationRatio;

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
  if (exceedsMaxInflationRatio(encoded.length, compressed.length, inflationRatioLimit)) {
    return {
      originalSize: encoded.length,
      wireBytes: encoded,
      cmp: "none",
    };
  }
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
  const inflationRatioLimit = opts.maxInflationRatio ?? maxInflationRatio;

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
  if (exceedsMaxInflationRatio(encoded.length, compressed.length, inflationRatioLimit)) {
    return {
      originalSize: encoded.length,
      wireBytes: encoded,
      cmp: "none",
    };
  }
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

/**
 * Re-wrap **already-encoded UTF-8 JSON bytes** (typically obtained via
 * {@link DecodedPayloadFrame.decodedBytes}) into a fresh `PayloadFrame`
 * envelope **without** going through `JSON.stringify` again.
 *
 * Used by the relay forwarder hot path (`rpc_bridge_agent_inbound.ts`) when an
 * agent's response/chunk is forwarded to a consumer without mutation of the
 * JSON-RPC body. Saves one parse + one stringify per forwarded frame, which
 * matters on streaming flows where chunks dominate volume.
 *
 * The caller is responsible for ensuring `bytes` is valid UTF-8 JSON; the
 * resulting envelope still carries the signature/cmp/originalSize fields
 * derived by the encoder, and the consumer's PayloadFrame decoder will catch
 * any corruption via its existing size + inflation guards.
 */
export const encodePayloadFrameFromBytes = (
  bytes: Buffer,
  options?: EncodePayloadFrameOptions,
): PayloadFrameEnvelope => {
  const compressionThreshold = effectiveEncodeCompressionThreshold(
    options?.compressionThreshold,
    bytes.length,
  );
  const body = preencodeUtf8Buffer(bytes, {
    compressionThreshold,
    ...(options?.compressionPolicy !== undefined
      ? { compressionPolicy: options.compressionPolicy }
      : {}),
    ...(options?.maxInflationRatio !== undefined
      ? { maxInflationRatio: options.maxInflationRatio }
      : {}),
    ...(options?.maxGzipInputBytes !== undefined
      ? { maxGzipInputBytes: options.maxGzipInputBytes }
      : {}),
  });
  return finishPayloadFrameEnvelope(body, options);
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
  readonly maxInflationRatio?: number;
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

/**
 * Shared encode options for high-frequency hub→agent frames (`rpc:stream.pull`,
 * `agent:capabilities`, `hub:heartbeat_ack`): skip gzip to avoid `gzipSync` on the event loop.
 */
export const PAYLOAD_FRAME_HOT_PATH_ENCODE_OPTIONS: Readonly<
  Pick<EncodePayloadFrameOptions, "compressionThreshold" | "omitTraceId">
> = {
  compressionThreshold: Number.POSITIVE_INFINITY,
  omitTraceId: true,
};

/** Synchronous hot-path encoder; always `cmp: none` (see `PAYLOAD_FRAME_HOT_PATH_ENCODE_OPTIONS`). */
export const encodePayloadFrameHotPath = (
  data: unknown,
  options?: Pick<EncodePayloadFrameOptions, "requestId" | "traceId">,
): PayloadFrameEnvelope =>
  encodePayloadFrame(data, {
    ...PAYLOAD_FRAME_HOT_PATH_ENCODE_OPTIONS,
    ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
    ...(options?.traceId !== undefined ? { traceId: options.traceId } : {}),
  });

export const encodePayloadFrame = (
  data: unknown,
  options?: EncodePayloadFrameOptions,
): PayloadFrameEnvelope => {
  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  const compressionThreshold = effectiveEncodeCompressionThreshold(
    options?.compressionThreshold,
    encoded.length,
  );
  const body = preencodeUtf8Buffer(encoded, {
    compressionThreshold,
    ...(options?.compressionPolicy !== undefined
      ? { compressionPolicy: options.compressionPolicy }
      : {}),
    ...(options?.maxInflationRatio !== undefined
      ? { maxInflationRatio: options.maxInflationRatio }
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

  const encoded = Buffer.from(JSON.stringify(data), "utf8");
  const compressionThreshold = effectiveEncodeCompressionThreshold(
    options?.compressionThreshold,
    encoded.length,
  );
  const preOpts: PreencodePayloadFrameJsonOptions = {
    compressionThreshold,
    ...(options?.compressionPolicy !== undefined
      ? { compressionPolicy: options.compressionPolicy }
      : {}),
    ...(options?.maxInflationRatio !== undefined
      ? { maxInflationRatio: options.maxInflationRatio }
      : {}),
    ...(options?.maxGzipInputBytes !== undefined
      ? { maxGzipInputBytes: options.maxGzipInputBytes }
      : {}),
  };

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
      decodedBytes,
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
 *
 * Uncompressed frames (`cmp: none`) bypass the gunzip branch entirely and go straight to JSON
 * parse — no try/catch overhead and no async machinery beyond the function's own Promise wrapper.
 */
export const decodePayloadFrameAsync = async (
  payload: unknown,
): Promise<Result<DecodedPayloadFrame>> => {
  const prep = validatePayloadFrameForDecode(payload);
  if (!prep.ok) {
    return prep;
  }

  const { envelope, binaryPayload } = prep.value;

  // Fast path: uncompressed frames need no gunzip — skip the try/catch and zlib branches.
  if (envelope.cmp !== "gzip") {
    return finalizeDecodedPayloadBytes(envelope, binaryPayload, binaryPayload);
  }

  const minAsync = env.payloadFrameAsyncGunzipMinCompressedBytes;
  let decodedBytes: Buffer;
  try {
    decodedBytes =
      minAsync > 0 && binaryPayload.length >= minAsync
        ? await gunzipAsync(binaryPayload)
        : gunzipSync(binaryPayload);
  } catch {
    return err(badRequest("Failed to decompress PayloadFrame payload"));
  }

  return finalizeDecodedPayloadBytes(envelope, binaryPayload, decodedBytes);
};
