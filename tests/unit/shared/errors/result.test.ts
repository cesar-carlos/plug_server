import { describe, it, expect } from "vitest";

import { AppError } from "../../../../src/shared/errors/app_error";
import { ok, err, isOk, isErr, unwrap, unwrapOr } from "../../../../src/shared/errors/result";

const makeError = (msg = "fail"): AppError =>
  new AppError(msg, { statusCode: 400, code: "BAD_REQUEST" });

describe("ok", () => {
  it("should create an Ok result with the given value", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it("should work with object values", () => {
    const result = ok({ id: "1", name: "test" });
    expect(result.value).toEqual({ id: "1", name: "test" });
  });
});

describe("err", () => {
  it("should create an Err result with the given error", () => {
    const error = makeError();
    const result = err(error);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(error);
  });
});

describe("isOk / isErr", () => {
  it("isOk should return true for Ok", () => {
    expect(isOk(ok("x"))).toBe(true);
  });

  it("isOk should return false for Err", () => {
    expect(isOk(err(makeError()))).toBe(false);
  });

  it("isErr should return true for Err", () => {
    expect(isErr(err(makeError()))).toBe(true);
  });

  it("isErr should return false for Ok", () => {
    expect(isErr(ok("x"))).toBe(false);
  });
});

describe("unwrap", () => {
  it("should return the value from an Ok result", () => {
    expect(unwrap(ok(99))).toBe(99);
  });

  it("should throw the AppError from an Err result", () => {
    const error = makeError("something went wrong");
    expect(() => unwrap(err(error))).toThrow("something went wrong");
  });
});

describe("unwrapOr", () => {
  it("should return the value from an Ok result", () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
  });

  it("should return the fallback from an Err result", () => {
    expect(unwrapOr(err(makeError()), 0)).toBe(0);
  });
});
