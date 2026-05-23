import { describe, expect, it } from "vitest";

import {
  buildLegacySocketAppErrorPayload,
  type LegacySocketAppErrorPayload,
} from "../../src/shared/constants/socket_app_error";
import { socketEvents } from "../../src/shared/constants/socket_events";

describe("socket app:error contract", () => {
  it("documents the legacy app:error envelope (not the canonical ack envelope)", () => {
    const payload: LegacySocketAppErrorPayload = buildLegacySocketAppErrorPayload(
      "SOCKET_PROTOCOL_ERROR",
      "agents:command payload must be an object",
    );

    expect(socketEvents.appError).toBe("app:error");
    expect(payload).toEqual({
      code: "SOCKET_PROTOCOL_ERROR",
      message: "agents:command payload must be an object",
    });
    expect(payload).not.toHaveProperty("success");
    expect(payload).not.toHaveProperty("requestId");
    expect(payload).not.toHaveProperty("error");
  });

  it("allows optional statusCode on legacy app:error payloads", () => {
    expect(
      buildLegacySocketAppErrorPayload("FORBIDDEN", "Account is blocked", 403),
    ).toEqual({
      code: "FORBIDDEN",
      message: "Account is blocked",
      statusCode: 403,
    });
  });
});
