import { describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  decodePayloadFrame,
  isPayloadFrameEnvelope,
} from "../../../../../src/shared/utils/payload_frame";
import {
  CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER,
  buildConnectionReadyPayloadForWire,
  warnIfConnectionReadyLegacyCompatExpired,
} from "../../../../../src/presentation/socket/hub/handshake/connection_ready_handshake";
import { logger } from "../../../../../src/shared/utils/logger";

describe("connection_ready_handshake", () => {
  it("builds a PayloadFrame by default and keeps a documented removal date", () => {
    expect(env.socketConnectionReadyCompatMode).toBe("payload_frame");
    expect(CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const payload = buildConnectionReadyPayloadForWire({
      id: "socket-1",
      message: "ready",
      user: null,
    });

    expect(isPayloadFrameEnvelope(payload)).toBe(true);
    const decoded = decodePayloadFrame(payload);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual({
        id: "socket-1",
        message: "ready",
        user: null,
      });
    }
  });

  it("can fall back to raw JSON only through the isolated legacy compat mode", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: {
        socketConnectionReadyCompatMode: "raw_json",
      },
    }));

    const mod =
      await import("../../../../../src/presentation/socket/hub/handshake/connection_ready_handshake");
    const payload = mod.buildConnectionReadyPayloadForWire({
      id: "socket-legacy",
      message: "legacy",
      user: null,
    });

    expect(payload).toEqual({
      id: "socket-legacy",
      message: "legacy",
      user: null,
    });

    vi.doUnmock("../../../../../src/shared/config/env");
    vi.resetModules();
  });

  it("warns at boot when the legacy compat removal date has passed", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnIfConnectionReadyLegacyCompatExpired(Date.parse("2026-10-01T00:00:00.000Z"), "raw_json");

    expect(warnSpy).toHaveBeenCalledWith("connection_ready_legacy_compat_past_removal_date", {
      removeAfter: CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER,
      compatMode: "raw_json",
      remediation:
        "Delete raw_json compat in connection_ready_handshake.ts and remove SOCKET_CONNECTION_READY_COMPAT_MODE from env/docs.",
    });

    warnSpy.mockRestore();
  });

  it("does not warn before the legacy compat removal date", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnIfConnectionReadyLegacyCompatExpired(
      Date.parse("2026-09-30T12:00:00.000Z"),
      env.socketConnectionReadyCompatMode,
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
