import { describe, expect, it } from "vitest";

import {
  buildHttpErrorResponseBody,
  type HttpErrorResponseBody,
} from "../../src/presentation/http/helpers/http_error_response";
import { normalizeZodIssues } from "../../src/presentation/http/middlewares/validate.middleware";
import { clientAgentIdsBodySchema } from "../../src/presentation/http/validators/client_agents.validator";

describe("HTTP error envelope contract", () => {
  it("preserves element errors alongside the size error for oversized agent lists", () => {
    const result = clientAgentIdsBodySchema.safeParse({
      agentIds: ["not-a-uuid", ...Array<string>(100).fill("123e4567-e89b-42d3-a456-426614174000")],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected oversized agent list to fail validation");

    const issues = [
      { field: "agentIds.0", message: "Must be a valid UUID" },
      { field: "agentIds", message: "Too big: expected array to have <=100 items" },
    ];
    const body = buildHttpErrorResponseBody({
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      issues: normalizeZodIssues(result.error),
    });

    expect(body.issues).toEqual(issues);
    expect(body.error.details).toEqual({ issues });
  });

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
