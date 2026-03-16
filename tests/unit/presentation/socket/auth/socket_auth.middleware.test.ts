import { beforeEach, describe, expect, it, vi } from "vitest";

import { authenticateSocket } from "../../../../../src/presentation/socket/auth/socket_auth.middleware";
import { AppError } from "../../../../../src/shared/errors/app_error";
import { verifyAccessToken } from "../../../../../src/shared/utils/jwt";

vi.mock("../../../../../src/shared/utils/jwt", () => ({
  verifyAccessToken: vi.fn(),
}));

const mockedVerifyAccessToken = vi.mocked(verifyAccessToken);

describe("authenticateSocket middleware", () => {
  beforeEach(() => {
    mockedVerifyAccessToken.mockReset();
  });

  it("rejects connection without token when auth is required", () => {
    const socket = {
      handshake: {
        headers: {},
        auth: {},
      },
      data: {},
    };
    const next = vi.fn();

    authenticateSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("rejects invalid token", () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: false,
      error: new AppError("Invalid token", { statusCode: 401, code: "INVALID_TOKEN" }),
    });

    const socket = {
      handshake: {
        headers: {},
        auth: { token: "bad-token" },
      },
      data: {},
    };
    const next = vi.fn();

    authenticateSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("INVALID_TOKEN");
  });

  it("stores authenticated user data for valid token", () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: true,
      value: {
        sub: "user-1",
        email: "user@test.com",
        role: "user",
        tokenType: "access",
      },
    });

    const socket = {
      handshake: {
        headers: {},
        auth: { token: "valid-token" },
      },
      data: {},
    };
    const next = vi.fn();

    authenticateSocket(socket as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toMatchObject({ sub: "user-1", tokenType: "access" });
  });
});
