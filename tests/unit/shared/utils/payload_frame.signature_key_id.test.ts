import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PayloadFrameModule from "../../../../src/shared/utils/payload_frame";

const SIGNING_KEY = "test-shared-key-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SIGNING_KEY_ID = "hub-key-2026";
const SHARED_VECTOR_KEY = "server-shared-secret";
const SHARED_VECTOR_KEY_ID = "shared-key-01";

const baseEnv = {
  payloadSigningKey: undefined as string | undefined,
  payloadSigningKeyId: undefined as string | undefined,
  payloadSigningPreviousKeys: {} as Record<string, string>,
  payloadSignOutbound: false,
  payloadFrameMaxGzipInputBytes: 1_048_576,
  payloadFrameGzipLevel: undefined as number | undefined,
  payloadFrameAutoGzipMinSavingsBytes: 64,
  payloadFrameAsyncGzipMinUtf8Bytes: 0,
  payloadFrameAsyncGunzipMinCompressedBytes: 0,
};

const buildSignatureValue = (
  frame: {
    schemaVersion: string;
    enc: string;
    cmp: string;
    contentType: string;
    originalSize: number;
    compressedSize: number;
    traceId: string | null;
    requestId: string | null;
  },
  binaryPayload: Buffer,
  key: string,
): string => {
  const input = JSON.stringify({
    cmp: frame.cmp,
    compressedSize: frame.compressedSize,
    contentType: frame.contentType,
    enc: frame.enc,
    originalSize: frame.originalSize,
    payload: binaryPayload.toString("base64"),
    requestId: frame.requestId,
    schemaVersion: frame.schemaVersion,
    traceId: frame.traceId,
  });
  return createHmac("sha256", key).update(input).digest("base64");
};

describe("validateFrameSignature key_id enforcement (PAYLOAD_SIGNING_KEY_ID)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../../../../src/shared/config/env");
  });

  beforeEach(() => {
    vi.resetModules();
  });

  const loadModuleWithEnv = async (
    overrides: Partial<typeof baseEnv>,
  ): Promise<typeof PayloadFrameModule> => {
    vi.doMock("../../../../src/shared/config/env", () => ({
      env: { ...baseEnv, ...overrides },
    }));
    return import("../../../../src/shared/utils/payload_frame");
  };

  it("accepts a frame without key_id when PAYLOAD_SIGNING_KEY_ID is unset (single-key deployment)", async () => {
    const mod = await loadModuleWithEnv({ payloadSigningKey: SIGNING_KEY });
    const frameWithoutSig = mod.encodePayloadFrame({ ok: true }, { omitTraceId: true });
    const binaryPayload = Buffer.from(frameWithoutSig.payload as Buffer);
    const value = buildSignatureValue(
      {
        schemaVersion: frameWithoutSig.schemaVersion,
        enc: frameWithoutSig.enc,
        cmp: frameWithoutSig.cmp,
        contentType: frameWithoutSig.contentType,
        originalSize: frameWithoutSig.originalSize,
        compressedSize: frameWithoutSig.compressedSize,
        traceId: null,
        requestId: null,
      },
      binaryPayload,
      SIGNING_KEY,
    );

    const signedFrame = {
      ...frameWithoutSig,
      signature: { alg: "hmac-sha256" as const, value },
    };
    const decoded = mod.decodePayloadFrame(signedFrame);
    expect(decoded.ok).toBe(true);
  });

  it("REJECTS a frame missing key_id when PAYLOAD_SIGNING_KEY_ID is configured", async () => {
    const mod = await loadModuleWithEnv({
      payloadSigningKey: SIGNING_KEY,
      payloadSigningKeyId: SIGNING_KEY_ID,
    });
    const frameWithoutSig = mod.encodePayloadFrame({ ok: true }, { omitTraceId: true });
    const binaryPayload = Buffer.from(frameWithoutSig.payload as Buffer);
    const value = buildSignatureValue(
      {
        schemaVersion: frameWithoutSig.schemaVersion,
        enc: frameWithoutSig.enc,
        cmp: frameWithoutSig.cmp,
        contentType: frameWithoutSig.contentType,
        originalSize: frameWithoutSig.originalSize,
        compressedSize: frameWithoutSig.compressedSize,
        traceId: null,
        requestId: null,
      },
      binaryPayload,
      SIGNING_KEY,
    );

    const signedFrame = {
      ...frameWithoutSig,
      signature: { alg: "hmac-sha256" as const, value },
    };
    const decoded = mod.decodePayloadFrame(signedFrame);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.message).toMatch(/missing key_id/i);
    }
  });

  it("REJECTS a frame whose key_id does not match the configured PAYLOAD_SIGNING_KEY_ID", async () => {
    const mod = await loadModuleWithEnv({
      payloadSigningKey: SIGNING_KEY,
      payloadSigningKeyId: SIGNING_KEY_ID,
    });
    const frameWithoutSig = mod.encodePayloadFrame({ ok: true }, { omitTraceId: true });
    const binaryPayload = Buffer.from(frameWithoutSig.payload as Buffer);
    const value = buildSignatureValue(
      {
        schemaVersion: frameWithoutSig.schemaVersion,
        enc: frameWithoutSig.enc,
        cmp: frameWithoutSig.cmp,
        contentType: frameWithoutSig.contentType,
        originalSize: frameWithoutSig.originalSize,
        compressedSize: frameWithoutSig.compressedSize,
        traceId: null,
        requestId: null,
      },
      binaryPayload,
      SIGNING_KEY,
    );

    const signedFrame = {
      ...frameWithoutSig,
      signature: { alg: "hmac-sha256" as const, value, key_id: "wrong-key-id" },
    };
    const decoded = mod.decodePayloadFrame(signedFrame);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.message).toMatch(/key_id is not recognized/i);
    }
  });

  it("ACCEPTS a frame with the matching key_id", async () => {
    const mod = await loadModuleWithEnv({
      payloadSigningKey: SIGNING_KEY,
      payloadSigningKeyId: SIGNING_KEY_ID,
    });
    const frameWithoutSig = mod.encodePayloadFrame({ ok: true }, { omitTraceId: true });
    const binaryPayload = Buffer.from(frameWithoutSig.payload as Buffer);
    const value = buildSignatureValue(
      {
        schemaVersion: frameWithoutSig.schemaVersion,
        enc: frameWithoutSig.enc,
        cmp: frameWithoutSig.cmp,
        contentType: frameWithoutSig.contentType,
        originalSize: frameWithoutSig.originalSize,
        compressedSize: frameWithoutSig.compressedSize,
        traceId: null,
        requestId: null,
      },
      binaryPayload,
      SIGNING_KEY,
    );

    const signedFrame = {
      ...frameWithoutSig,
      signature: { alg: "hmac-sha256" as const, value, key_id: SIGNING_KEY_ID },
    };
    const decoded = mod.decodePayloadFrame(signedFrame);
    expect(decoded.ok).toBe(true);
  });

  it("ACCEPTS the shared plug_agente transport-frame HMAC test vector", async () => {
    const mod = await loadModuleWithEnv({
      payloadSigningKey: SHARED_VECTOR_KEY,
      payloadSigningKeyId: SHARED_VECTOR_KEY_ID,
    });

    const decoded = mod.decodePayloadFrame({
      schemaVersion: "1.0",
      enc: "json",
      cmp: "none",
      contentType: "application/json",
      originalSize: 11,
      compressedSize: 11,
      payload: [123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125],
      traceId: "trace-001",
      requestId: "req-001",
      signature: {
        alg: "hmac-sha256",
        value: "UpUVUNDM/kDYdffl79uJdmrE002MhtUdQ+KYLyiAYkE=",
        key_id: SHARED_VECTOR_KEY_ID,
      },
    });

    expect(decoded.ok).toBe(true);
  });
});
