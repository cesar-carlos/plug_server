import { describe, it, expect } from "vitest";

import {
  badRequest,
  unauthorized,
  invalidToken,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  internalError,
  serviceUnavailable,
} from "../../../../src/shared/errors/http_errors";

const expectError = (error: ReturnType<typeof badRequest>, status: number, code: string): void => {
  expect(error.statusCode).toBe(status);
  expect(error.code).toBe(code);
  expect(error.name).toBe("AppError");
};

describe("http_errors", () => {
  it("badRequest — 400 BAD_REQUEST with message and details", () => {
    const e = badRequest("Missing field", { field: "email" });
    expectError(e, 400, "BAD_REQUEST");
    expect(e.message).toBe("Missing field");
    expect(e.details).toEqual({ field: "email" });
  });

  it("unauthorized — 401 UNAUTHORIZED with default message", () => {
    const e = unauthorized();
    expectError(e, 401, "UNAUTHORIZED");
    expect(e.message).toBe("Authentication required");
  });

  it("unauthorized — 401 UNAUTHORIZED with custom message", () => {
    const e = unauthorized("Login first");
    expect(e.message).toBe("Login first");
  });

  it("invalidToken — 401 INVALID_TOKEN with default message", () => {
    const e = invalidToken();
    expectError(e, 401, "INVALID_TOKEN");
    expect(e.message).toBe("Invalid or expired token");
  });

  it("forbidden — 403 FORBIDDEN with default message", () => {
    const e = forbidden();
    expectError(e, 403, "FORBIDDEN");
  });

  it("notFound — 404 NOT_FOUND with resource name in message", () => {
    const e = notFound("User");
    expectError(e, 404, "NOT_FOUND");
    expect(e.message).toBe("User not found");
  });

  it("conflict — 409 CONFLICT", () => {
    const e = conflict("Email already in use");
    expectError(e, 409, "CONFLICT");
    expect(e.message).toBe("Email already in use");
  });

  it("unprocessable — 422 UNPROCESSABLE_ENTITY", () => {
    const e = unprocessable("Invalid data", { reason: "test" });
    expectError(e, 422, "UNPROCESSABLE_ENTITY");
    expect(e.details).toEqual({ reason: "test" });
  });

  it("tooManyRequests — 429 TOO_MANY_REQUESTS", () => {
    const e = tooManyRequests();
    expectError(e, 429, "TOO_MANY_REQUESTS");
  });

  it("internalError — 500 INTERNAL_SERVER_ERROR", () => {
    const e = internalError();
    expectError(e, 500, "INTERNAL_SERVER_ERROR");
  });

  it("serviceUnavailable — 503 SERVICE_UNAVAILABLE", () => {
    const e = serviceUnavailable();
    expectError(e, 503, "SERVICE_UNAVAILABLE");
  });
});
