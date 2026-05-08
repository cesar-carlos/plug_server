import { describe, expect, it } from "vitest";

import {
  resolveAppErrorRetryAfterMs,
  resolveRpcRetryAfterSeconds,
} from "../../../../../src/presentation/socket/consumers/socket_retry_after";
import { serviceUnavailableWithRetry } from "../../../../../src/shared/errors/http_errors";

describe("socket retry-after helpers", () => {
  it("extracts retryAfterMs from AppError details", () => {
    expect(resolveAppErrorRetryAfterMs(serviceUnavailableWithRetry("overloaded", 1234))).toBe(1234);
  });

  it("extracts retryAfterSeconds from normalized RPC -32013 errors", () => {
    const retryAfterSeconds = resolveRpcRetryAfterSeconds({
      type: "single",
      item: {
        success: false,
        error: {
          code: -32013,
          message: "rate_limited",
          data: { retry_after_ms: 2200 },
        },
      },
    });
    expect(retryAfterSeconds).toBe(3);
  });
});
