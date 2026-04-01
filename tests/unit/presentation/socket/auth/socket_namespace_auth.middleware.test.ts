import { beforeEach, describe, expect, it, vi } from "vitest";

import { User } from "../../../../../src/domain/entities/user.entity";
import {
  authenticateAgentSocket,
  authenticateConsumerSocket,
} from "../../../../../src/presentation/socket/auth/socket_namespace_auth.middleware";
import { AppError } from "../../../../../src/shared/errors/app_error";
import { forbidden } from "../../../../../src/shared/errors/http_errors";
import { err, ok } from "../../../../../src/shared/errors/result";
import { verifyAccessToken } from "../../../../../src/shared/utils/jwt";

vi.mock("../../../../../src/shared/utils/jwt", () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock("../../../../../src/shared/config/env", () => ({
  env: {
    socketAuthRequired: true,
    socketAgentRoles: ["agent"],
    socketConsumerRoles: ["user", "admin"],
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
    email: "a@b.com",
    passwordHash: "h",
    role: "user",
    status: "active",
    createdAt: new Date(),
  });

describe("authenticateAgentSocket", () => {
  beforeEach(() => {
    mockedVerifyAccessToken.mockReset();
    mockedGetActiveAccountUser.mockReset();
    mockedGetActiveAccountUser.mockImplementation(async (userId: string) => ok(activeUser(userId)));
  });

  it("rejects connection without token", async () => {
    const socket = {
      handshake: { headers: {}, auth: {} },
      data: {},
    };
    const next = vi.fn();

    await authenticateAgentSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mockedGetActiveAccountUser).not.toHaveBeenCalled();
  });

  it("rejects role user for /agents", async () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: true,
      value: {
        sub: "user-1",
        role: "user",
        tokenType: "access",
      },
    });

    const socket = {
      handshake: { headers: {}, auth: { token: "valid" } },
      data: {},
    };
    const next = vi.fn();

    await authenticateAgentSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("not allowed");
    expect(mockedGetActiveAccountUser).not.toHaveBeenCalled();
  });

  it("accepts role agent for /agents", async () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: true,
      value: {
        sub: "agent-1",
        role: "agent",
        tokenType: "access",
      },
    });

    const socket = {
      handshake: { headers: {}, auth: { token: "valid" } },
      data: {},
    };
    const next = vi.fn();

    await authenticateAgentSocket(socket as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockedGetActiveAccountUser).toHaveBeenCalledWith("agent-1");
    expect(socket.data.user).toMatchObject({ sub: "agent-1", role: "agent" });
  });

  it("rejects blocked account for /agents", async () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: true,
      value: {
        sub: "agent-1",
        role: "agent",
        tokenType: "access",
      },
    });
    mockedGetActiveAccountUser.mockResolvedValueOnce(err(forbidden("Account is blocked")));

    const socket = {
      handshake: { headers: {}, auth: { token: "valid" } },
      data: {},
    };
    const next = vi.fn();

    await authenticateAgentSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("Account is blocked");
    expect(socket.data.user).toBeUndefined();
  });
});

describe("authenticateConsumerSocket", () => {
  beforeEach(() => {
    mockedVerifyAccessToken.mockReset();
    mockedGetActiveAccountUser.mockReset();
    mockedGetActiveAccountUser.mockImplementation(async (userId: string) => ok(activeUser(userId)));
  });

  it("rejects connection without token", async () => {
    const socket = {
      handshake: { headers: {}, auth: {} },
      data: {},
    };
    const next = vi.fn();

    await authenticateConsumerSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mockedGetActiveAccountUser).not.toHaveBeenCalled();
  });

  it("rejects role agent for /consumers", async () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: true,
      value: {
        sub: "agent-1",
        role: "agent",
        tokenType: "access",
      },
    });

    const socket = {
      handshake: { headers: {}, auth: { token: "valid" } },
      data: {},
    };
    const next = vi.fn();

    await authenticateConsumerSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("cannot connect");
    expect(mockedGetActiveAccountUser).not.toHaveBeenCalled();
  });

  it("accepts role user for /consumers", async () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: true,
      value: {
        sub: "user-1",
        role: "user",
        tokenType: "access",
      },
    });

    const socket = {
      handshake: { headers: {}, auth: { token: "valid" } },
      data: {},
    };
    const next = vi.fn();

    await authenticateConsumerSocket(socket as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockedGetActiveAccountUser).toHaveBeenCalledWith("user-1");
    expect(socket.data.user).toMatchObject({ sub: "user-1", role: "user" });
  });

  it("rejects blocked account for /consumers", async () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: true,
      value: {
        sub: "user-1",
        role: "user",
        tokenType: "access",
      },
    });
    mockedGetActiveAccountUser.mockResolvedValueOnce(err(forbidden("Account is blocked")));

    const socket = {
      handshake: { headers: {}, auth: { token: "valid" } },
      data: {},
    };
    const next = vi.fn();

    await authenticateConsumerSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.message).toBe("Account is blocked");
  });
});
