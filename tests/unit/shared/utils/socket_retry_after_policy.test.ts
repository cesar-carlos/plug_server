import { describe, expect, it } from "vitest";

import { resolveSocketRetryAfterMs } from "../../../../src/shared/utils/socket_retry_after_policy";

describe("socket_retry_after_policy", () => {
  it("reads retryAfterMs from socket envelope errors", () => {
    expect(
      resolveSocketRetryAfterMs({
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", retryAfterMs: 250 },
      }),
    ).toBe(250);
  });

  it("converts legacy agents:command retryAfterSeconds", () => {
    expect(
      resolveSocketRetryAfterMs({
        success: true,
        retryAfterSeconds: 3,
        response: { type: "single" },
      }),
    ).toBe(3000);
  });

  it("reads JSON-RPC retry_after_ms from a single normalized response", () => {
    expect(
      resolveSocketRetryAfterMs({
        success: true,
        response: {
          type: "single",
          item: {
            error: {
              code: -32013,
              message: "retry later",
              data: { retry_after_ms: 1500 },
            },
          },
        },
      }),
    ).toBe(1500);
  });

  it("returns the largest retry hint in a batch response", () => {
    expect(
      resolveSocketRetryAfterMs({
        success: true,
        response: {
          type: "batch",
          items: [
            { error: { data: { retry_after_ms: 200 } } },
            { error: { data: { retry_after_ms: 900 } } },
          ],
        },
      }),
    ).toBe(900);
  });
});
