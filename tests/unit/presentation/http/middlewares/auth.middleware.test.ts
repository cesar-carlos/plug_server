import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../../../../src/shared/errors/app_error";
import { requireAuth } from "../../../../../src/presentation/http/middlewares/auth.middleware";
import { verifyAccessToken } from "../../../../../src/shared/utils/jwt";

vi.mock("../../../../../src/shared/utils/jwt", () => ({
  verifyAccessToken: vi.fn(),
}));

const mockedVerifyAccessToken = vi.mocked(verifyAccessToken);

describe("requireAuth middleware", () => {
  beforeEach(() => {
    mockedVerifyAccessToken.mockReset();
  });

  it("returns unauthorized when authorization header is missing", () => {
    const request = { headers: {} } as Request;
    const response = { locals: {} } as Response;
    const next = vi.fn() as NextFunction;

    requireAuth(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("returns token error when bearer token is invalid", () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: false,
      error: new AppError("Invalid token", { statusCode: 401, code: "INVALID_TOKEN" }),
    });

    const request = { headers: { authorization: "Bearer invalid" } } as unknown as Request;
    const response = { locals: {} } as Response;
    const next = vi.fn() as NextFunction;

    requireAuth(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe("INVALID_TOKEN");
  });

  it("stores auth user in response.locals for valid token", () => {
    mockedVerifyAccessToken.mockReturnValue({
      ok: true,
      value: {
        sub: "user-id",
        email: "user@test.com",
        role: "user",
        tokenType: "access",
      },
    });

    const request = { headers: { authorization: "Bearer valid" } } as unknown as Request;
    const response = { locals: {} } as Response;
    const next = vi.fn() as NextFunction;

    requireAuth(request, response, next);

    expect(next).toHaveBeenCalledWith();
    expect(response.locals.authUser).toMatchObject({
      sub: "user-id",
      tokenType: "access",
    });
  });
});
