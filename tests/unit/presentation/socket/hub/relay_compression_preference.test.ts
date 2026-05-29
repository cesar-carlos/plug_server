import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../../../src/shared/errors/app_error";
import { resolveAgentCompressionPreference } from "../../../../../src/presentation/socket/hub/relay/relay_compression_preference";

const unsupported = (): AppError =>
  new AppError("unsupported", { statusCode: 503, code: "UNSUPPORTED" });

describe("resolveAgentCompressionPreference", () => {
  it("throws the caller-specific error when the agent advertises no compression", () => {
    const build = vi.fn(unsupported);
    expect(() =>
      resolveAgentCompressionPreference({
        preference: undefined,
        allowsNoneCompression: false,
        allowsGzip: false,
        buildUnsupportedError: build,
      }),
    ).toThrow(/unsupported/);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("rejects an explicit gzip preference when the agent disallows gzip", () => {
    expect(() =>
      resolveAgentCompressionPreference({
        preference: "always",
        allowsNoneCompression: true,
        allowsGzip: false,
        buildUnsupportedError: unsupported,
      }),
    ).toThrow(/do not allow gzip/i);
  });

  it("rejects an explicit none preference when the agent disallows uncompressed", () => {
    expect(() =>
      resolveAgentCompressionPreference({
        preference: "none",
        allowsNoneCompression: false,
        allowsGzip: true,
        buildUnsupportedError: unsupported,
      }),
    ).toThrow(/do not allow uncompressed/i);
  });

  it("returns the explicit preference when compatible", () => {
    expect(
      resolveAgentCompressionPreference({
        preference: "always",
        allowsNoneCompression: true,
        allowsGzip: true,
        buildUnsupportedError: unsupported,
      }),
    ).toBe("always");
  });

  it("falls back to undefined (encoder default) for gzip-capable agents with no preference", () => {
    expect(
      resolveAgentCompressionPreference({
        preference: undefined,
        allowsNoneCompression: true,
        allowsGzip: true,
        buildUnsupportedError: unsupported,
      }),
    ).toBeUndefined();
  });

  it("falls back to 'none' for gzip-incapable agents with no preference", () => {
    expect(
      resolveAgentCompressionPreference({
        preference: undefined,
        allowsNoneCompression: true,
        allowsGzip: false,
        buildUnsupportedError: unsupported,
      }),
    ).toBe("none");
  });
});
