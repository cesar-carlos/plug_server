import { describe, expect, it, vi } from "vitest";

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
});
