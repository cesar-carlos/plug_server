import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

const makeResponse = () => {
  const response = {
    locals: { requestId: "req-123" },
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return response;
};

describe("errorMiddleware", () => {
  it("does not expose details in production mode", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: { nodeEnv: "production" },
    }));
    vi.doMock("../../../../../src/shared/utils/logger", () => ({
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    }));

    const { errorMiddleware } = await import(
      "../../../../../src/presentation/http/middlewares/error.middleware"
    );
    const { AppError } = await import("../../../../../src/shared/errors/app_error");

    const response = makeResponse();
    const error = new AppError("Internal issue", {
      statusCode: 500,
      code: "INTERNAL_SERVER_ERROR",
      details: { stack: "secret" },
    });

    errorMiddleware(error, {} as Request, response, vi.fn() as NextFunction);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      message: "Internal issue",
      code: "INTERNAL_SERVER_ERROR",
      requestId: "req-123",
    });
  });

  it("exposes details in non-production mode for AppError", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/shared/config/env", () => ({
      env: { nodeEnv: "development" },
    }));
    vi.doMock("../../../../../src/shared/utils/logger", () => ({
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    }));

    const { errorMiddleware } = await import(
      "../../../../../src/presentation/http/middlewares/error.middleware"
    );
    const { AppError } = await import("../../../../../src/shared/errors/app_error");

    const response = makeResponse();
    const error = new AppError("Bad request", {
      statusCode: 400,
      code: "BAD_REQUEST",
      details: { field: "email" },
    });

    errorMiddleware(error, {} as Request, response, vi.fn() as NextFunction);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      message: "Bad request",
      code: "BAD_REQUEST",
      details: { field: "email" },
      requestId: "req-123",
    });
  });
});
