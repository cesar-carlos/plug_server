import { describe, expect, it } from "vitest";

import {
  buildHttpErrorResponseBody,
  type HttpErrorResponseBody,
} from "../../src/presentation/http/helpers/http_error_response";

describe("HTTP error envelope contract", () => {
  it("builds the canonical failure shape with nested error object", () => {
    const body: HttpErrorResponseBody = buildHttpErrorResponseBody({
      code: "NOT_FOUND",
      message: "Resource not found",
      requestId: "req-404",
    });

    expect(body).toEqual({
      success: false,
      code: "NOT_FOUND",
      message: "Resource not found",
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
      },
      requestId: "req-404",
    });
  });

  it("mirrors top-level code and message on the nested error object", () => {
    const body = buildHttpErrorResponseBody({
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      issues: [{ field: "email", message: "Must be a valid email address" }],
    });

    expect(body.success).toBe(false);
    expect(body.code).toBe(body.error.code);
    expect(body.message).toBe(body.error.message);
    expect(body.issues).toEqual([{ field: "email", message: "Must be a valid email address" }]);
    expect(body.error.details).toEqual({
      issues: [{ field: "email", message: "Must be a valid email address" }],
    });
  });

  it("omits requestId when not provided", () => {
    const body = buildHttpErrorResponseBody({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });

    expect(body).not.toHaveProperty("requestId");
  });
});
