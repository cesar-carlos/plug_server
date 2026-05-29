import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCorsOptions } from "../../../../src/shared/config/cors";

describe("buildCorsOptions", () => {
  it("returns wildcard policy without credentials when CORS is open", () => {
    const options = buildCorsOptions("*");

    expect(options.origin).toBe("*");
    expect(options.credentials).toBe(false);
  });

  it("allows configured origins and rejects unknown origins", async () => {
    const options = buildCorsOptions(["https://app.example.com", "https://admin.example.com"]);
    expect(typeof options.origin).toBe("function");

    const originHandler = options.origin as NonNullable<typeof options.origin>;
    const allowCallback = vi.fn();
    originHandler("https://admin.example.com", allowCallback);
    expect(allowCallback).toHaveBeenCalledWith(null, true);

    const rejectCallback = vi.fn();
    originHandler("https://evil.example.com", rejectCallback);
    const error = rejectCallback.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("not allowed");
  });

  it("always allows a missing Origin (non-browser / same-origin clients)", () => {
    const options = buildCorsOptions(["https://app.example.com"]);
    const originHandler = options.origin as NonNullable<typeof options.origin>;

    const allowCallback = vi.fn();
    originHandler(undefined, allowCallback);
    expect(allowCallback).toHaveBeenCalledWith(null, true);
  });

  it('allows the literal string "null" outside production (opaque origin / email webviews)', () => {
    const options = buildCorsOptions(["https://app.example.com"]);
    const originHandler = options.origin as NonNullable<typeof options.origin>;

    const allowCallback = vi.fn();
    originHandler("null", allowCallback);
    expect(allowCallback).toHaveBeenCalledWith(null, true);
  });

  describe("in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    const previousAccessSecret = process.env.JWT_ACCESS_SECRET;
    const previousRefreshSecret = process.env.JWT_REFRESH_SECRET;

    afterEach(() => {
      process.env.NODE_ENV = previousNodeEnv;
      process.env.CORS_ORIGIN = previousCorsOrigin;
      process.env.JWT_ACCESS_SECRET = previousAccessSecret;
      process.env.JWT_REFRESH_SECRET = previousRefreshSecret;
      vi.resetModules();
    });

    it('rejects the literal string "null" (no reflected credentials)', async () => {
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGIN = "https://app.example.com";
      process.env.JWT_ACCESS_SECRET = "production-access-secret-32chars";
      process.env.JWT_REFRESH_SECRET = "production-refresh-secret-32chars";
      vi.resetModules();

      const { buildCorsOptions: buildProd } = await import("../../../../src/shared/config/cors");
      const options = buildProd(["https://app.example.com"]);
      const originHandler = options.origin as NonNullable<typeof options.origin>;

      const callback = vi.fn();
      originHandler("null", callback);
      expect(callback).toHaveBeenCalledWith(null, false);
    });
  });
});
