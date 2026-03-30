import { describe, expect, it } from "vitest";

import {
  decodePayloadFrame,
  encodePayloadFrame,
  isPayloadFrameEnvelope,
  PAYLOAD_FRAME_SCHEMA_VERSION,
} from "../../../../src/shared/utils/payload_frame";

describe("isPayloadFrameEnvelope (plug_agente payload-frame.schema.json alignment)", () => {
  it("accepts hub-encoded frames", () => {
    const frame = encodePayloadFrame({ ok: true }, { requestId: "r1", omitTraceId: true });
    expect(isPayloadFrameEnvelope(frame)).toBe(true);
    const decoded = decodePayloadFrame(frame);
    expect(decoded.ok).toBe(true);
  });

  it("decodes frames whose payload is a base64 string", () => {
    const frame = encodePayloadFrame({ ok: true }, { requestId: "r1", omitTraceId: true });
    const payload = Buffer.isBuffer(frame.payload)
      ? frame.payload.toString("base64")
      : Buffer.from(frame.payload).toString("base64");
    const base64Frame = { ...frame, payload };

    expect(isPayloadFrameEnvelope(base64Frame)).toBe(true);
    const decoded = decodePayloadFrame(base64Frame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual({ ok: true });
    }
  });

  it("rejects wrong schemaVersion", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true });
    const frame = { ...base, schemaVersion: "2.0" };
    expect(isPayloadFrameEnvelope(frame)).toBe(false);
    expect(decodePayloadFrame(frame).ok).toBe(false);
  });

  it("rejects missing contentType", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true }) as Record<string, unknown>;
    const { contentType: _c, ...rest } = base;
    expect(isPayloadFrameEnvelope(rest)).toBe(false);
  });

  it("rejects wrong contentType", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true });
    const frame = { ...base, contentType: "text/plain" };
    expect(isPayloadFrameEnvelope(frame)).toBe(false);
  });

  it("rejects unknown root property", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true }) as Record<string, unknown>;
    const frame = { ...base, extraField: 1 };
    expect(isPayloadFrameEnvelope(frame)).toBe(false);
  });

  it("rejects non-integer originalSize", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true });
    const frame = { ...base, originalSize: 1.5 };
    expect(isPayloadFrameEnvelope(frame)).toBe(false);
  });

  it("rejects negative compressedSize", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true });
    const frame = { ...base, compressedSize: -1 };
    expect(isPayloadFrameEnvelope(frame)).toBe(false);
  });

  it("allows requestId null on otherwise valid frame", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true });
    const frame = { ...base, requestId: null };
    expect(isPayloadFrameEnvelope(frame)).toBe(true);
  });

  it("rejects traceId when not a string", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true });
    const frame = { ...base, traceId: 123 };
    expect(isPayloadFrameEnvelope(frame)).toBe(false);
  });

  it("rejects signature with unknown property", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true }) as Record<string, unknown>;
    const frame = {
      ...base,
      signature: { alg: "hmac-sha256", value: "abc", key_id: "k1", extra: true },
    };
    expect(isPayloadFrameEnvelope(frame)).toBe(false);
  });

  it("rejects signature with wrong alg", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true }) as Record<string, unknown>;
    const frame = {
      ...base,
      signature: { alg: "md5", value: "abc" },
    };
    expect(isPayloadFrameEnvelope(frame)).toBe(false);
  });

  it("accepts signature with alg and value only (hub may omit key_id)", () => {
    const base = encodePayloadFrame({ a: 1 }, { omitTraceId: true }) as Record<string, unknown>;
    const frame = {
      ...base,
      signature: { alg: "hmac-sha256", value: "dGVzdA==" },
    };
    expect(isPayloadFrameEnvelope(frame)).toBe(true);
  });

  it("exports schema version constant", () => {
    expect(PAYLOAD_FRAME_SCHEMA_VERSION).toBe("1.0");
  });
});
