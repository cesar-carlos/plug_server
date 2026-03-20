import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  decodePayloadFrame,
  decodePayloadFrameAsync,
  encodePayloadFrame,
  encodePayloadFrameBridge,
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

  it("default auto leaves small payload uncompressed (below 1024 threshold)", () => {
    const frame = encodePayloadFrame(small, { requestId: "r1", traceId: "t1" });
    expect(frame.cmp).toBe("none");
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

  it("always preference forces gzip on small payload", () => {
    const frame = encodePayloadFrame(small, {
      requestId: "r1",
      traceId: "t1",
      ...payloadFrameEncodeOptionsFromPreference("always"),
    });
    expect(frame.cmp).toBe("gzip");
  });

  it("auto compresses redundant large JSON when gzip is smaller", () => {
    const largeSql = "SELECT 1 " + "x".repeat(2000);
    const frame = encodePayloadFrame(
      {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "q",
        params: { sql: largeSql, client_token: "t" },
      },
      { compressionPolicy: "auto", compressionThreshold: 1024 },
    );
    expect(frame.cmp).toBe("gzip");
  });

  it("auto uses none when gzip does not shrink (high-entropy blob)", () => {
    const blob = randomBytes(4096).toString("base64");
    const data = { jsonrpc: "2.0", method: "rpc.discover", id: "x", params: { blob } };
    const encoded = Buffer.from(JSON.stringify(data), "utf8");
    expect(encoded.length).toBeGreaterThanOrEqual(1024);
    const gz = gzipSync(encoded);
    if (gz.length < encoded.length) {
      const frame = encodePayloadFrame(data, { compressionPolicy: "auto", compressionThreshold: 1024 });
      expect(frame.cmp).toBe("gzip");
      return;
    }
    const frame = encodePayloadFrame(data, { compressionPolicy: "auto", compressionThreshold: 1024 });
    expect(frame.cmp).toBe("none");
    expect(frame.compressedSize).toBe(encoded.length);
  });

  it("always_gzip uses gzip even when result is larger than raw", () => {
    const frame = encodePayloadFrame(small, {
      compressionThreshold: 1,
      compressionPolicy: "always_gzip",
    });
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
    const largeSql = "SELECT 1 " + "x".repeat(2000);
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
    const largeSql = "SELECT 1 " + "x".repeat(2000);
    const data = {
      jsonrpc: "2.0",
      method: "sql.execute",
      id: "q",
      params: { sql: largeSql, client_token: "t" },
    };
    const frame = encodePayloadFrame(data, { compressionPolicy: "auto", compressionThreshold: 1024 });
    expect(frame.cmp).toBe("gzip");
    const sync = decodePayloadFrame(frame);
    const asyncResult = await decodePayloadFrameAsync(frame);
    expect(asyncResult).toEqual(sync);
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
      maxGzipInputBytes: 2 * 1024 * 1024,
    });
    expect(body.originalSize).toBeGreaterThan(512 * 1024);
    expect(body.cmp).toBe("gzip");
    expect(body.wireBytes.length).toBeLessThan(body.originalSize);
  });
});
