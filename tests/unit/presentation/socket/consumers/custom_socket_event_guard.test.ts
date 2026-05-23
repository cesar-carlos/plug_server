import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../../../../src/shared/errors/app_error";
import { buildLegacySocketAppErrorPayload } from "../../../../../src/shared/constants/socket_app_error";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

vi.mock("../../../../../src/presentation/socket/auth/ensure_socket_active_account", () => ({
  assertJwtUserAccountActive: vi.fn(),
}));

import {
  assertActiveClientCustomSocketEventPrincipal,
  disconnectSocketAfterCustomSocketEventAuthFailure,
  handleCustomSocketEventAuthFailure,
  isNonClientCustomSocketEventPrincipalError,
  isTerminalCustomSocketEventAuthFailure,
} from "../../../../../src/presentation/socket/consumers/custom_socket_event_guard";
import { assertJwtUserAccountActive } from "../../../../../src/presentation/socket/auth/ensure_socket_active_account";

const mockedAssertJwtUserAccountActive = vi.mocked(assertJwtUserAccountActive);

describe("custom_socket_event_guard", () => {
  beforeEach(() => {
    mockedAssertJwtUserAccountActive.mockReset();
  });

  it("returns the client sub when the principal is an active client", async () => {
    mockedAssertJwtUserAccountActive.mockResolvedValue(undefined);
    const socket = {
      data: {
        user: { sub: " client-1 ", principal_type: "client" },
      },
    } as never;

    await expect(assertActiveClientCustomSocketEventPrincipal(socket)).resolves.toBe("client-1");
  });

  it("rejects non-client principals with FORBIDDEN", async () => {
    mockedAssertJwtUserAccountActive.mockResolvedValue(undefined);
    const socket = {
      data: {
        user: { sub: "user-1", principal_type: "user", role: "admin" },
      },
    } as never;

    await expect(assertActiveClientCustomSocketEventPrincipal(socket)).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
  });

  it("emits appError and disconnects the socket on terminal auth failure", () => {
    const emit = vi.fn();
    const disconnect = vi.fn();
    const socket = {
      connected: true,
      emit,
      disconnect,
    } as never;
    const error = new AppError("Authentication required", {
      statusCode: 401,
      code: "UNAUTHORIZED",
    });

    disconnectSocketAfterCustomSocketEventAuthFailure(socket, error);

    expect(emit).toHaveBeenCalledWith(
      socketEvents.appError,
      buildLegacySocketAppErrorPayload("UNAUTHORIZED", "Authentication required", 401),
    );
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it("does not disconnect when the socket is already disconnected", () => {
    const emit = vi.fn();
    const disconnect = vi.fn();
    const socket = {
      connected: false,
      emit,
      disconnect,
    } as never;

    disconnectSocketAfterCustomSocketEventAuthFailure(
      socket,
      new AppError("Authentication required", { statusCode: 401, code: "UNAUTHORIZED" }),
    );

    expect(emit).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("normalizes unknown errors to UNAUTHORIZED AppError", () => {
    const normalized = handleCustomSocketEventAuthFailure(new Error("boom"));
    expect(normalized).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
  });

  it("identifies terminal auth failures and non-client principal errors", () => {
    const unauthorized = new AppError("Authentication required", {
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    const forbidden = new AppError("Only Client principals may use custom socket events", {
      statusCode: 403,
      code: "FORBIDDEN",
    });
    const rateLimited = new AppError("Too many requests", {
      statusCode: 429,
      code: "RATE_LIMITED",
    });

    expect(isTerminalCustomSocketEventAuthFailure(unauthorized)).toBe(true);
    expect(isTerminalCustomSocketEventAuthFailure(forbidden)).toBe(true);
    expect(isTerminalCustomSocketEventAuthFailure(rateLimited)).toBe(false);
    expect(isNonClientCustomSocketEventPrincipalError(forbidden)).toBe(true);
    expect(isNonClientCustomSocketEventPrincipalError(unauthorized)).toBe(false);
  });
});
