import { describe, it, expect } from "vitest";
import { z } from "zod";

import { AppError } from "../../../../src/shared/errors/app_error";
import { extractErrorMessage, tryCatch, tryCatchAsync } from "../../../../src/shared/errors/try_catch";

// ─── extractErrorMessage ─────────────────────────────────────────────────────

describe("extractErrorMessage", () => {
  it("should return AppError message directly", () => {
    const e = new AppError("App level error", { statusCode: 400, code: "BAD_REQUEST" });
    expect(extractErrorMessage(e)).toBe("App level error");
  });

  it("should join ZodError issues with field paths", () => {
    const result = z.object({ email: z.string().email("Invalid email") }).safeParse({ email: "bad" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = extractErrorMessage(result.error);
      expect(msg).toContain("email");
      expect(msg).toContain("Invalid email");
    }
  });

  it("should return the message from a native Error", () => {
    expect(extractErrorMessage(new Error("native error"))).toBe("native error");
  });

  it("should return a plain string as-is", () => {
    expect(extractErrorMessage("plain string error")).toBe("plain string error");
  });

  it("should JSON-serialize an unknown object", () => {
    expect(extractErrorMessage({ code: 42 })).toBe('{"code":42}');
  });

  it("should return the fallback for null", () => {
    expect(extractErrorMessage(null, "fallback")).toBe("fallback");
  });

  it("should return the fallback for undefined", () => {
    expect(extractErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});

// ─── tryCatch ────────────────────────────────────────────────────────────────

describe("tryCatch", () => {
  it("should return Ok when the function succeeds", () => {
    const result = tryCatch(() => 42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it("should return Err with the AppError when an AppError is thrown", () => {
    const error = new AppError("known error", { statusCode: 404, code: "NOT_FOUND" });
    const result = tryCatch(() => { throw error; });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("known error");
      expect(result.error.statusCode).toBe(404);
    }
  });

  it("should wrap a native Error and extract its message", () => {
    const result = tryCatch(() => { throw new Error("native failure"); }, "fallback");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("native failure");
    }
  });

  it("should use the fallback message when error has no message", () => {
    const result = tryCatch(() => { throw null; }, "fallback message");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("fallback message");
    }
  });

  it("should apply custom statusCode and code to wrapped errors", () => {
    const result = tryCatch(
      () => { throw new Error("oops"); },
      "oops",
      { statusCode: 422, code: "UNPROCESSABLE_ENTITY" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(422);
      expect(result.error.code).toBe("UNPROCESSABLE_ENTITY");
    }
  });
});

// ─── tryCatchAsync ───────────────────────────────────────────────────────────

describe("tryCatchAsync", () => {
  it("should return Ok when the async function resolves", async () => {
    const result = await tryCatchAsync(async () => "resolved");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("resolved");
  });

  it("should return Err when the async function rejects with AppError", async () => {
    const error = new AppError("async failure", { statusCode: 503, code: "SERVICE_UNAVAILABLE" });
    const result = await tryCatchAsync(async () => { throw error; });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("async failure");
      expect(result.error.statusCode).toBe(503);
    }
  });

  it("should wrap a rejected promise with the extracted message", async () => {
    const result = await tryCatchAsync(
      async () => { throw new Error("db connection failed"); },
      "Database error",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("db connection failed");
    }
  });
});
