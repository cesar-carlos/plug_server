import { describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  decodePayloadFrame,
  encodePayloadFrame,
  isPayloadFrameEnvelope,
} from "../../../../../src/shared/utils/payload_frame";
import { logger } from "../../../../../src/shared/utils/logger";
import {
  AGENTS_COMMAND_LEGACY_COMPAT_REMOVE_AFTER,
  buildAgentsCommandResponseForWire,
  buildAgentsCommandStreamEventForWire,
  decodeAgentsCommandInboundPayload,
  warnIfAgentsCommandLegacyCompatExpired,
} from "../../../../../src/presentation/socket/consumers/agents_command_wire";

const validCommandBody = {
  agentId: "agent-1",
  command: {
    jsonrpc: "2.0",
    id: "req-1",
    method: "sql.execute",
    params: { sql: "SELECT 1" },
  },
};

describe("agents_command_wire", () => {
  it("builds a PayloadFrame response by default and keeps a documented removal date", () => {
    expect(env.socketAgentsCommandCompatMode).toBe("payload_frame");
    expect(AGENTS_COMMAND_LEGACY_COMPAT_REMOVE_AFTER).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const payload = buildAgentsCommandResponseForWire({
      success: true,
      requestId: "req-1",
      response: { type: "single", success: true, item: { id: "req-1", result: { ok: true } } },
    });

    expect(isPayloadFrameEnvelope(payload)).toBe(true);
    const decoded = decodePayloadFrame(payload);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual({
        success: true,
        requestId: "req-1",
        response: { type: "single", success: true, item: { id: "req-1", result: { ok: true } } },
      });
      expect(decoded.value.frame.requestId).toBe("req-1");
    }
  });

  it("accepts inbound plain JSON during the migration window", () => {
    const decoded = decodeAgentsCommandInboundPayload(validCommandBody);
    expect(decoded).toEqual({ ok: true, data: validCommandBody });
  });

  it("accepts inbound PayloadFrame during the migration window", () => {
    const framed = encodePayloadFrame(validCommandBody, { requestId: "req-1", omitTraceId: true });
    const decoded = decodeAgentsCommandInboundPayload(framed);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.data).toEqual(validCommandBody);
    }
  });

  it("rejects invalid inbound PayloadFrame with a protocol message", () => {
    const decoded = decodeAgentsCommandInboundPayload({
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
    expect(decodeAgentsCommandInboundPayload("invalid")).toEqual({
      ok: false,
      message: "agents:command payload must be an object or PayloadFrame",
    });
  });

  it("frames stream chunk and complete events on the hot path", () => {
    const chunkPayload = {
      stream_id: "stream-1",
      request_id: "req-1",
      chunk_index: 0,
      rows: [{ id: 1 }],
    };
    const chunkWire = buildAgentsCommandStreamEventForWire(chunkPayload);
    expect(isPayloadFrameEnvelope(chunkWire)).toBe(true);
    const chunkDecoded = decodePayloadFrame(chunkWire);
    expect(chunkDecoded.ok).toBe(true);
    if (chunkDecoded.ok) {
      expect(chunkDecoded.value.data).toEqual(chunkPayload);
      expect(chunkDecoded.value.frame.cmp).toBe("none");
      expect(chunkDecoded.value.frame.requestId).toBe("req-1");
    }

    const completePayload = {
      stream_id: "stream-1",
      request_id: "req-1",
      total_rows: 1,
    };
    const completeWire = buildAgentsCommandStreamEventForWire(completePayload);
    expect(isPayloadFrameEnvelope(completeWire)).toBe(true);
  });

  it("can fall back to raw JSON outbound only through the isolated legacy compat mode", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: {
        socketAgentsCommandCompatMode: "raw_json",
      },
    }));

    const mod =
      await import("../../../../../src/presentation/socket/consumers/agents_command_wire");
    const response = mod.buildAgentsCommandResponseForWire({
      success: false,
      requestId: "req-legacy",
      error: { code: "VALIDATION_ERROR", message: "bad" },
    });
    expect(response).toEqual({
      success: false,
      requestId: "req-legacy",
      error: { code: "VALIDATION_ERROR", message: "bad" },
    });
    expect(isPayloadFrameEnvelope(response)).toBe(false);

    const stream = mod.buildAgentsCommandStreamEventForWire({
      stream_id: "s1",
      request_id: "req-legacy",
    });
    expect(stream).toEqual({ stream_id: "s1", request_id: "req-legacy" });

    vi.doUnmock("../../../../../src/shared/config/env");
    vi.resetModules();
  });

  it("warns at boot when the legacy compat removal date has passed", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnIfAgentsCommandLegacyCompatExpired(Date.parse("2026-10-01T00:00:00.000Z"), "raw_json");

    expect(warnSpy).toHaveBeenCalledWith("agents_command_legacy_compat_past_removal_date", {
      removeAfter: AGENTS_COMMAND_LEGACY_COMPAT_REMOVE_AFTER,
      compatMode: "raw_json",
      remediation:
        "Delete raw_json compat in agents_command_wire.ts and remove SOCKET_AGENTS_COMMAND_COMPAT_MODE from env/docs.",
    });

    warnSpy.mockRestore();
  });

  it("does not warn before the legacy compat removal date", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnIfAgentsCommandLegacyCompatExpired(
      Date.parse("2026-09-30T12:00:00.000Z"),
      env.socketAgentsCommandCompatMode,
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
