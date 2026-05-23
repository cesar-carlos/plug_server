import { describe, expect, it } from "vitest";

import {
  attachHttpRequestId,
  buildHttpSuccessResponseBody,
} from "../../src/presentation/http/helpers/http_success_response";

/**
 * Auth login/refresh responses use a legacy flat shape (not `{ success, data }`).
 * Controllers add `success: true` and `token` (alias for `accessToken`) for plug_agente
 * compatibility. New endpoints should prefer `buildHttpSuccessResponseBody`.
 */
describe("HTTP auth legacy success contract", () => {
  it("documents the flat AuthTokens legacy shape", () => {
    const legacyAuthTokens = {
      accessToken: "access.jwt",
      refreshToken: "refresh.jwt",
      success: true as const,
      token: "access.jwt",
    };

    expect(legacyAuthTokens.token).toBe(legacyAuthTokens.accessToken);
    expect(legacyAuthTokens).not.toHaveProperty("data");
    expect(legacyAuthTokens).not.toHaveProperty("error");
  });

  it("buildHttpSuccessResponseBody produces the canonical envelope for new endpoints", () => {
    expect(
      buildHttpSuccessResponseBody({
        data: { message: "pong" },
        requestId: "req-ping",
      }),
    ).toEqual({
      success: true,
      data: { message: "pong" },
      requestId: "req-ping",
    });
  });

  it("attachHttpRequestId preserves flat payloads for utility endpoints", () => {
    expect(attachHttpRequestId({ message: "pong" }, "req-ping")).toEqual({
      message: "pong",
      requestId: "req-ping",
    });
    expect(attachHttpRequestId({ message: "pong" }, undefined)).toEqual({ message: "pong" });
  });
});
