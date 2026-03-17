import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticateAgentSocket,
  authenticateConsumerSocket,
} from "../../../../../src/presentation/socket/auth/socket_namespace_auth.middleware";
import { AppError } from "../../../../../src/shared/errors/app_error";
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

const mockedVerifyAccessToken = vi.mocked(verifyAccessToken);

describe("authenticateAgentSocket", () => {
  beforeEach(() => {
    mockedVerifyAccessToken.mockReset();
  });

  it("rejects connection without token", () => {
    const socket = {
      handshake: { headers: {}, auth: {} },
      data: {},
    };
    const next = vi.fn();

    authenticateAgentSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("rejects role user for /agents", () => {
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

    authenticateAgentSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("not allowed");
  });

  it("accepts role agent for /agents", () => {
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

    authenticateAgentSocket(socket as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toMatchObject({ sub: "agent-1", role: "agent" });
  });
});

describe("authenticateConsumerSocket", () => {
  beforeEach(() => {
    mockedVerifyAccessToken.mockReset();
  });

  it("rejects connection without token", () => {
    const socket = {
      handshake: { headers: {}, auth: {} },
      data: {},
    };
    const next = vi.fn();

    authenticateConsumerSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("rejects role agent for /consumers", () => {
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

    authenticateConsumerSocket(socket as never, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain("cannot connect");
  });

  it("accepts role user for /consumers", () => {
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

    authenticateConsumerSocket(socket as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toMatchObject({ sub: "user-1", role: "user" });
  });
});
