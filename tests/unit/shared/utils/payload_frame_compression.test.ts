import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodePayloadFrame,
  decodePayloadFrameAsync,
  encodePayloadFrame,
  encodePayloadFrameBridge,
  encodePayloadFrameFromPreencodedWire,
  encodePayloadFrameHotPath,
  payloadFrameEncodeOptionsFromPreference,
  preencodePayloadFrameJson,
} from "../../../../src/shared/utils/payload_frame";

describe("payloadFrameEncodeOptionsFromPreference", () => {
  it("returns empty object for default and undefined", () => {
    expect(payloadFrameEncodeOptionsFromPreference(undefined)).toEqual({});
    expect(payloadFrameEncodeOptionsFromPreference("default")).toEqual({});
  });

  it("returns Infinity threshold for none", () => {
    expect(payloadFrameEncodeOptionsFromPreference("none")).toEqual({
      compressionThreshold: Number.POSITIVE_INFINITY,
    });
  });

  it("returns always_gzip for always", () => {
    expect(payloadFrameEncodeOptionsFromPreference("always")).toEqual({
      compressionThreshold: 1,
      compressionPolicy: "always_gzip",
    });
  });
});

describe("encodePayloadFrame compression policy", () => {
  const small = { jsonrpc: "2.0", method: "rpc.discover", id: "a" };

  it("default auto leaves small payload uncompressed (below 4096 threshold)", () => {
    const frame = encodePayloadFrame(small, { requestId: "r1", traceId: "t1" });
    expect(frame.cmp).toBe("none");
  });

  it("default auto uses the hub 4096-byte threshold", () => {
    const belowDefaultThreshold = {
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "below",
      params: { sql: "SELECT 1 " + "x".repeat(2500), client_token: "t" },
    };
    const aboveDefaultThreshold = {
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "above",
      params: { sql: "SELECT 1 " + "x".repeat(5000), client_token: "t" },
    };

    expect(encodePayloadFrame(belowDefaultThreshold).cmp).toBe("none");
    expect(
      encodePayloadFrame(aboveDefaultThreshold, {
        maxInflationRatio: Number.POSITIVE_INFINITY,
      }).cmp,
    ).toBe("gzip");
  });

  it("omitTraceId skips envelope traceId when no explicit traceId", () => {
    const frame = encodePayloadFrame(small, { requestId: "r1", omitTraceId: true });
    expect(frame.requestId).toBe("r1");
    expect(frame.traceId).toBeUndefined();
  });

  it("explicit traceId wins over omitTraceId", () => {
    const frame = encodePayloadFrame(small, {
      requestId: "r1",
      traceId: "fixed",
      omitTraceId: true,
    });
    expect(frame.traceId).toBe("fixed");
  });

  it("always preference skips gzip on small payload below global compress min", () => {
    const frame = encodePayloadFrame(small, {
      requestId: "r1",
      traceId: "t1",
      ...payloadFrameEncodeOptionsFromPreference("always"),
    });
    expect(frame.cmp).toBe("none");
  });

  it("always preference forces gzip on payload above global compress min", () => {
    const largeSql = "SELECT 1 " + "x".repeat(5000);
    const frame = encodePayloadFrame(
      {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q",
        params: { sql: largeSql, client_token: "t" },
      },
      {
        requestId: "r1",
        traceId: "t1",
        maxInflationRatio: Number.POSITIVE_INFINITY,
        ...payloadFrameEncodeOptionsFromPreference("always"),
      },
    );
    expect(frame.cmp).toBe("gzip");
  });

  it("auto compresses redundant large JSON when gzip is smaller", () => {
    const largeSql = "SELECT 1 " + "x".repeat(5000);
    const frame = encodePayloadFrame(
      {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q",
        params: { sql: largeSql, client_token: "t" },
      },
      {
        compressionPolicy: "auto",
        compressionThreshold: 1024,
        maxInflationRatio: Number.POSITIVE_INFINITY,
      },
    );
    expect(frame.cmp).toBe("gzip");
  });

  it("auto uses none when gzip would exceed the default inflation ratio", () => {
    const largeSql = "SELECT 1 " + "x".repeat(5000);
    const frame = encodePayloadFrame(
      {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q",
        params: { sql: largeSql, client_token: "t" },
      },
      { compressionPolicy: "auto", compressionThreshold: 1024 },
    );
    expect(frame.cmp).toBe("none");
    expect(frame.compressedSize).toBe(frame.originalSize);
  });

  it("auto uses none when gzip does not shrink (high-entropy blob)", () => {
    const blob = randomBytes(4096).toString("base64");
    const data = { jsonrpc: "2.0", method: "rpc.discover", id: "x", params: { blob } };
    const encoded = Buffer.from(JSON.stringify(data), "utf8");
    expect(encoded.length).toBeGreaterThanOrEqual(1024);
    const gz = gzipSync(encoded);
    if (gz.length < encoded.length) {
      const frame = encodePayloadFrame(data, {
        compressionPolicy: "auto",
        compressionThreshold: 1024,
      });
      expect(frame.cmp).toBe("gzip");
      return;
    }
    const frame = encodePayloadFrame(data, {
      compressionPolicy: "auto",
      compressionThreshold: 1024,
    });
    expect(frame.cmp).toBe("none");
    expect(frame.compressedSize).toBe(encoded.length);
  });

  it("always_gzip uses gzip even when result is larger than raw (above compress min)", () => {
    const largeSql = "SELECT 1 " + "x".repeat(5000);
    const frame = encodePayloadFrame(
      {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q",
        params: { sql: largeSql, client_token: "t" },
      },
      {
        compressionThreshold: 1,
        compressionPolicy: "always_gzip",
        maxInflationRatio: Number.POSITIVE_INFINITY,
      },
    );
    expect(frame.cmp).toBe("gzip");
  });

  it("none keeps large payload uncompressed", () => {
    const largeSql = "SELECT 1 " + "x".repeat(1100);
    const frame = encodePayloadFrame(
      {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q1",
        params: { sql: largeSql, client_token: "t" },
      },
      {
        requestId: "r1",
        traceId: "t1",
        compressionThreshold: Number.POSITIVE_INFINITY,
      },
    );
    expect(frame.cmp).toBe("none");
  });
});

describe("encodePayloadFrameHotPath", () => {
  it("never gzip-compresses and omits traceId by default", () => {
    const largeSql = "SELECT 1 " + "x".repeat(5000);
    const frame = encodePayloadFrameHotPath(
      {
        stream_id: "stream-1",
        request_id: "req-1",
        window_size: 256,
        sql: largeSql,
      },
      { requestId: "req-1" },
    );
    expect(frame.cmp).toBe("none");
    expect(frame.requestId).toBe("req-1");
    expect(frame.traceId).toBeUndefined();
    expect(frame.compressedSize).toBe(frame.originalSize);
  });
});

describe("encodePayloadFrameBridge", () => {
  it("with asyncGzipMinUtf8Bytes 0 delegates to sync encode", async () => {
    const small = { jsonrpc: "2.0", method: "rpc.discover", id: "a" };
    const frame = await encodePayloadFrameBridge(small, {
      requestId: "r1",
      omitTraceId: true,
      asyncGzipMinUtf8Bytes: 0,
    });
    expect(frame.cmp).toBe("none");
    expect(frame.requestId).toBe("r1");
    expect(frame.traceId).toBeUndefined();
  });

  it("uses async gzip path when eligible and over async threshold", async () => {
    const largeSql = "SELECT 1 " + "x".repeat(5000);
    const data = {
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "q",
      params: { sql: largeSql, client_token: "t" },
    };
    const frame = await encodePayloadFrameBridge(data, {
      requestId: "r1",
      omitTraceId: true,
      compressionPolicy: "auto",
      compressionThreshold: 1024,
      maxInflationRatio: Number.POSITIVE_INFINITY,
      asyncGzipMinUtf8Bytes: 1024,
    });
    expect(frame.cmp).toBe("gzip");
  });
});

describe("decodePayloadFrameAsync", () => {
  it("matches sync decode for uncompressed frame", async () => {
    const small = { jsonrpc: "2.0", method: "rpc.discover", id: "a" };
    const frame = encodePayloadFrame(small, { requestId: "r1", omitTraceId: true });
    const sync = decodePayloadFrame(frame);
    const asyncResult = await decodePayloadFrameAsync(frame);
    expect(asyncResult).toEqual(sync);
  });

  it("matches sync decode for gzip frame", async () => {
    const largeSql = "SELECT 1 " + "x".repeat(5000);
    const data = {
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "q",
      params: { sql: largeSql, client_token: "t" },
    };
    const frame = encodePayloadFrame(data, {
      compressionPolicy: "auto",
      compressionThreshold: 1024,
      maxInflationRatio: Number.POSITIVE_INFINITY,
    });
    expect(frame.cmp).toBe("gzip");
    const sync = decodePayloadFrame(frame);
    const asyncResult = await decodePayloadFrameAsync(frame);
    expect(asyncResult).toEqual(sync);
  });
});

describe("PAYLOAD_FRAME_COMPRESS_MIN_BYTES (encodePayloadFrame global gate)", () => {
  const baseEnv = {
    payloadFrameCompressMinBytes: 4096,
    payloadFrameMaxGzipInputBytes: 1_048_576,
    payloadFrameGzipLevel: undefined as number | undefined,
    payloadFrameAutoGzipMinSavingsBytes: 64,
    payloadFrameAsyncGzipMinUtf8Bytes: 0,
    payloadFrameAsyncGunzipMinCompressedBytes: 0,
    payloadSignOutbound: false,
    payloadSigningKey: undefined as string | undefined,
    payloadSigningKeyId: undefined as string | undefined,
    payloadSigningPreviousKeys: {} as Record<string, string>,
  };

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../../../../src/shared/config/env");
  });

  const loadPayloadFrameWithEnv = async (
    overrides: Partial<typeof baseEnv>,
  ): Promise<{
    encodePayloadFrameBridge: typeof encodePayloadFrameBridge;
    encodePayloadFrame: typeof encodePayloadFrame;
  }> => {
    vi.doMock("../../../../src/shared/config/env", () => ({
      env: { ...baseEnv, ...overrides },
    }));
    return import("../../../../src/shared/utils/payload_frame");
  };

  it("encodePayloadFrameBridge skips gzip below env compress min", async () => {
    const mod = await loadPayloadFrameWithEnv({ payloadFrameCompressMinBytes: 4096 });
    const frame = await mod.encodePayloadFrameBridge(
      { jsonrpc: "2.0", method: "rpc.discover", id: "a" },
      {
        compressionThreshold: 1,
        compressionPolicy: "always_gzip",
        asyncGzipMinUtf8Bytes: 0,
      },
    );
    expect(frame.cmp).toBe("none");
  });

  it("encodePayloadFrame uses env compress min when threshold omitted", async () => {
    const mod = await loadPayloadFrameWithEnv({ payloadFrameCompressMinBytes: 2048 });
    const below = mod.encodePayloadFrame({ x: "y".repeat(1800) });
    expect(below.cmp).toBe("none");
    const above = mod.encodePayloadFrame(
      { x: "y".repeat(2500) },
      { maxInflationRatio: Number.POSITIVE_INFINITY },
    );
    expect(above.cmp).toBe("gzip");
  });

  it("encodePayloadFrame skips gzip when payload is below env min even with always_gzip", async () => {
    const mod = await loadPayloadFrameWithEnv({ payloadFrameCompressMinBytes: 2048 });
    const frame = mod.encodePayloadFrame(
      { jsonrpc: "2.0", method: "rpc.discover", id: "a" },
      { compressionThreshold: 1, compressionPolicy: "always_gzip" },
    );
    expect(frame.cmp).toBe("none");
  });

  it("env min 0 disables global gate for explicit low thresholds", async () => {
    const mod = await loadPayloadFrameWithEnv({ payloadFrameCompressMinBytes: 0 });
    const frame = mod.encodePayloadFrame(
      { jsonrpc: "2.0", method: "rpc.discover", id: "a" },
      { compressionThreshold: 1, compressionPolicy: "always_gzip" },
    );
    expect(frame.cmp).toBe("gzip");
  });
});

describe("preencodePayloadFrameJson backward compat (numeric second arg)", () => {
  it("uses numeric threshold with auto policy", () => {
    const body = preencodePayloadFrameJson({ x: "y".repeat(2000) }, 1024);
    expect(body.originalSize).toBeGreaterThanOrEqual(1024);
    expect(["gzip", "none"]).toContain(body.cmp);
  });
});

describe("preencodePayloadFrameJson maxGzipInputBytes", () => {
  it("skips gzip when JSON exceeds maxGzipInputBytes (compressible payload)", () => {
    const data = { blob: "a".repeat(600_000) };
    const body = preencodePayloadFrameJson(data, {
      compressionThreshold: 1024,
      compressionPolicy: "auto",
      maxGzipInputBytes: 512 * 1024,
    });
    expect(body.originalSize).toBeGreaterThan(512 * 1024);
    expect(body.cmp).toBe("none");
    expect(body.wireBytes.length).toBe(body.originalSize);
  });

  it("allows gzip above default ceiling when maxGzipInputBytes is raised", () => {
    const data = { blob: "a".repeat(600_000) };
    const body = preencodePayloadFrameJson(data, {
      compressionThreshold: 1024,
      compressionPolicy: "auto",
      maxInflationRatio: Number.POSITIVE_INFINITY,
      maxGzipInputBytes: 2 * 1024 * 1024,
    });
    expect(body.originalSize).toBeGreaterThan(512 * 1024);
    expect(body.cmp).toBe("gzip");
    expect(body.wireBytes.length).toBeLessThan(body.originalSize);
  });
});

describe("encodePayloadFrameFromPreencodedWire", () => {
  it("reuses compressed wire bytes without a second gzip", () => {
    // Moderately compressible JSON (gzip wins) without exceeding decode inflation guards.
    const data = {
      rows: Array.from({ length: 80 }, (_, i) => ({
        i,
        label: `row-${i}-value-${i * 7}`,
        note: `note-${i}`,
      })),
    };
    const encoded = encodePayloadFrame(data, {
      compressionThreshold: 1,
      compressionPolicy: "always_gzip",
      requestId: "in-1",
      omitTraceId: true,
    });
    expect(encoded.cmp).toBe("gzip");
    expect(Buffer.isBuffer(encoded.payload)).toBe(true);

    const forwarded = encodePayloadFrameFromPreencodedWire(
      {
        originalSize: encoded.originalSize,
        wireBytes: encoded.payload as Buffer,
        cmp: "gzip",
      },
      { requestId: "out-1", omitTraceId: true },
    );

    expect(forwarded.cmp).toBe("gzip");
    expect(forwarded.originalSize).toBe(encoded.originalSize);
    expect(forwarded.compressedSize).toBe(encoded.compressedSize);
    expect(forwarded.requestId).toBe("out-1");
    expect(Buffer.compare(forwarded.payload as Buffer, encoded.payload as Buffer)).toBe(0);

    const decoded = decodePayloadFrame(forwarded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual(data);
    }
  });
});
