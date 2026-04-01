import { beforeEach, describe, expect, it, vi } from "vitest";

import { User } from "../../../../../src/domain/entities/user.entity";
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
      getActiveAccountUser: vi.fn(),
    },
  },
}));

import { container } from "../../../../../src/shared/di/container";

const mockedVerifyAccessToken = vi.mocked(verifyAccessToken);
const mockedGetActiveAccountUser = vi.mocked(container.authService.getActiveAccountUser);

const activeUser = (id: string): User =>
  new User({
    id,
    email: "u@test.com",
    passwordHash: "h",
    role: "user",
    status: "active",
    createdAt: new Date(),
  });

describe("authenticateSocket middleware", () => {
  beforeEach(() => {
    mockedVerifyAccessToken.mockReset();
    mockedGetActiveAccountUser.mockReset();
    mockedGetActiveAccountUser.mockImplementation(async (userId: string) => ok(activeUser(userId)));
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
    expect(mockedGetActiveAccountUser).not.toHaveBeenCalled();
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
    expect(mockedGetActiveAccountUser).not.toHaveBeenCalled();
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
    expect(mockedGetActiveAccountUser).toHaveBeenCalledWith("user-1");
    expect(socket.data.user).toMatchObject({ sub: "user-1", tokenType: "access" });
  });
});
