import type { AppError } from "../../../../shared/errors/app_error";
import { badRequest } from "../../../../shared/errors/http_errors";
import type { PayloadFrameCompression } from "../../../../shared/validators/agent_command";

/**
 * Resolves the effective hub→agent PayloadFrame compression preference against
 * the agent's negotiated capabilities, throwing when the request is incompatible:
 *
 * - no advertised compression at all → `buildUnsupportedError()` (caller-specific:
 *   relay returns a `badRequest`, the REST command dispatch a `serviceUnavailable`);
 * - `"always"` (gzip) but the agent disallows gzip → `badRequest`;
 * - `"none"` but the agent disallows uncompressed → `badRequest`.
 *
 * When no preference is given, falls back to `"none"` for gzip-incapable agents
 * and `undefined` (encoder default) otherwise.
 *
 * Shared by the relay and REST command dispatchers, which had identical
 * gzip/none capability checks.
 */
export const resolveAgentCompressionPreference = (input: {
  readonly preference: PayloadFrameCompression | undefined;
  readonly allowsNoneCompression: boolean;
  readonly allowsGzip: boolean;
  readonly buildUnsupportedError: () => AppError;
}): PayloadFrameCompression | undefined => {
  const { preference, allowsNoneCompression, allowsGzip, buildUnsupportedError } = input;
  if (!allowsNoneCompression && !allowsGzip) {
    throw buildUnsupportedError();
  }
  if (preference === "always" && !allowsGzip) {
    throw badRequest("Agent capabilities do not allow gzip compression for PayloadFrame");
  }
  if (preference === "none" && !allowsNoneCompression) {
    throw badRequest("Agent capabilities do not allow uncompressed PayloadFrame");
  }
  if (preference !== undefined) {
    return preference;
  }
  return allowsGzip ? undefined : "none";
};
