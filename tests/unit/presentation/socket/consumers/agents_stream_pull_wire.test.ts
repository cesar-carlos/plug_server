import { describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  decodePayloadFrame,
  encodePayloadFrame,
  isPayloadFrameEnvelope,
} from "../../../../../src/shared/utils/payload_frame";
import { logger } from "../../../../../src/shared/utils/logger";
import {
  AGENTS_STREAM_PULL_LEGACY_COMPAT_REMOVE_AFTER,
  buildAgentsStreamPullResponseForWire,
  decodeAgentsStreamPullInboundPayload,
  decodeAgentsStreamPullWirePayload,
  extractAgentsStreamPullRequestId,
  warnIfAgentsStreamPullLegacyCompatExpired,
} from "../../../../../src/presentation/socket/consumers/agents_stream_pull_wire";

const validPullBody = {
  requestId: "req-1",
  windowSize: 16,
};

describe("agents_stream_pull_wire", () => {
  it("builds a PayloadFrame response by default and keeps a documented removal date", () => {
    expect(env.socketAgentsStreamPullCompatMode).toBe("payload_frame");
    expect(AGENTS_STREAM_PULL_LEGACY_COMPAT_REMOVE_AFTER).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const payload = buildAgentsStreamPullResponseForWire({
      success: true,
      requestId: "req-1",
      streamId: "stream-1",
      windowSize: 16,
    });

    expect(isPayloadFrameEnvelope(payload)).toBe(true);
    const decoded = decodePayloadFrame(payload);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual({
        success: true,
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 16,
      });
      expect(decoded.value.frame.requestId).toBe("req-1");
      expect(decoded.value.frame.cmp).toBe("none");
    }
  });

  it("accepts inbound plain JSON during the migration window", () => {
    const decoded = decodeAgentsStreamPullInboundPayload(validPullBody);
    expect(decoded).toEqual({ ok: true, data: validPullBody });
  });

  it("accepts inbound PayloadFrame during the migration window", () => {
    const framed = encodePayloadFrame(validPullBody, { requestId: "req-1", omitTraceId: true });
    const decoded = decodeAgentsStreamPullInboundPayload(framed);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.data).toEqual(validPullBody);
    }
  });

  it("rejects invalid inbound PayloadFrame with a protocol message", () => {
    const decoded = decodeAgentsStreamPullInboundPayload({
      schemaVersion: "1.0",
      enc: "json",
      cmp: "none",
      contentType: "application/json",
      originalSize: 1,
      compressedSize: 999,
      payload: Buffer.from("{}").toString("base64"),
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.message.length).toBeGreaterThan(0);
    }
  });

  it("rejects non-object inbound payloads", () => {
    expect(decodeAgentsStreamPullInboundPayload("invalid")).toEqual({
      ok: false,
      message: "agents:stream_pull payload must be an object or PayloadFrame",
    });
  });

  it("decodes outbound wire payloads for tests and SDK helpers", () => {
    const wire = buildAgentsStreamPullResponseForWire({
      success: false,
      error: { code: "NOT_FOUND", message: "Stream route not found", statusCode: 404 },
    });
    const logical = decodeAgentsStreamPullWirePayload<{ success: boolean; error: { code: string } }>(
      wire,
    );
    expect(logical.success).toBe(false);
    expect(logical.error.code).toBe("NOT_FOUND");
  });

  it("extracts requestId from inbound pull body", () => {
    expect(extractAgentsStreamPullRequestId({ requestId: "req-1" })).toBe("req-1");
    expect(extractAgentsStreamPullRequestId({ request_id: "req-legacy" })).toBe("req-legacy");
    expect(extractAgentsStreamPullRequestId({ streamId: "stream-1" })).toBeUndefined();
  });

  it("can fall back to raw JSON outbound only through the isolated legacy compat mode", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: {
        socketAgentsStreamPullCompatMode: "raw_json",
      },
    }));

    const mod = await import(
      "../../../../../src/presentation/socket/consumers/agents_stream_pull_wire"
    );
    const response = mod.buildAgentsStreamPullResponseForWire({
      success: true,
      requestId: "req-legacy",
      streamId: "stream-1",
      windowSize: 8,
    });
    expect(response).toEqual({
      success: true,
      requestId: "req-legacy",
      streamId: "stream-1",
      windowSize: 8,
    });
    expect(isPayloadFrameEnvelope(response)).toBe(false);

    vi.doUnmock("../../../../../src/shared/config/env");
    vi.resetModules();
  });

  it("warns at boot when the legacy compat removal date has passed", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnIfAgentsStreamPullLegacyCompatExpired(
      Date.parse("2026-10-01T00:00:00.000Z"),
      "raw_json",
    );

    expect(warnSpy).toHaveBeenCalledWith("agents_stream_pull_legacy_compat_past_removal_date", {
      removeAfter: AGENTS_STREAM_PULL_LEGACY_COMPAT_REMOVE_AFTER,
      compatMode: "raw_json",
      remediation:
        "Delete raw_json compat in agents_stream_pull_wire.ts and remove SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE from env/docs.",
    });

    warnSpy.mockRestore();
  });

  it("does not warn before the legacy compat removal date", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnIfAgentsStreamPullLegacyCompatExpired(
      Date.parse("2026-09-30T12:00:00.000Z"),
      env.socketAgentsStreamPullCompatMode,
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
