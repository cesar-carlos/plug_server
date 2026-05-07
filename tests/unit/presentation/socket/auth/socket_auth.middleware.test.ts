import { beforeEach, describe, expect, it, vi } from "vitest";

import { authenticateSocket } from "../../../../../src/presentation/socket/auth/socket_auth.middleware";
import { AppError } from "../../../../../src/shared/errors/app_error";
import { ok } from "../../../../../src/shared/errors/result";
import { verifyAccessToken } from "../../../../../src/shared/utils/jwt";

vi.mock("../../../../../src/shared/utils/jwt", () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock("../../../../../src/shared/config/env", () => ({
  env: {
    socketAuthRequired: true,
  },
}));

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    authService: {
      getActiveAccountUserSnapshot: vi.fn(),
    },
  },
}));

import { container } from "../../../../../src/shared/di/container";

const mockedVerifyAccessToken = vi.mocked(verifyAccessToken);
const mockedGetActiveAccountUserSnapshot = vi.mocked(
  container.authService.getActiveAccountUserSnapshot,
);

const activeUserSnapshot = (id: string) =>
  ({
    id,
    status: "active" as const,
    credentialsUpdatedAt: new Date(0),
    role: "user",
  }) as const;

describe("authenticateSocket middleware", () => {
  beforeEach(() => {
    mockedVerifyAccessToken.mockReset();
    mockedGetActiveAccountUserSnapshot.mockReset();
    mockedGetActiveAccountUserSnapshot.mockImplementation(async (userId: string) =>
      ok(activeUserSnapshot(userId)),
    );
  });

  it("rejects connection without token when auth is required", async () => {
    const socket = {
      handshake: {
        headers: {},
        auth: {},
      },
      data: {},
    };
    const next = vi.fn();

    await authenticateSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mockedGetActiveAccountUserSnapshot).not.toHaveBeenCalled();
  });

  it("rejects invalid token", async () => {
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

    await authenticateSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("INVALID_TOKEN");
    expect(mockedGetActiveAccountUserSnapshot).not.toHaveBeenCalled();
  });

  it("stores authenticated user data for valid token", async () => {
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

    await authenticateSocket(socket as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockedGetActiveAccountUserSnapshot).toHaveBeenCalledWith("user-1", undefined);
    expect(socket.data.user).toMatchObject({ sub: "user-1", tokenType: "access" });
  });
});
