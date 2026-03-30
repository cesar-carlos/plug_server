import { describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  decodePayloadFrame,
  isPayloadFrameEnvelope,
} from "../../../../../src/shared/utils/payload_frame";
import {
  CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER,
  buildConnectionReadyPayloadForWire,
} from "../../../../../src/presentation/socket/hub/connection_ready_handshake";

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
      await import("../../../../../src/presentation/socket/hub/connection_ready_handshake");
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
});
