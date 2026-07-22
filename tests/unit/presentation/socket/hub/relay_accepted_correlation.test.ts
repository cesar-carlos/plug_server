import { describe, expect, it } from "vitest";

import { AppError } from "../../../../../src/shared/errors/app_error";
import {
  attachRelayClientRequestIdToAppError,
  ensureRelayClientRequestIdOnThrown,
  readRelayClientRequestIdFromError,
} from "../../../../../src/presentation/socket/hub/relay/relay_accepted_correlation";

describe("relay_accepted_correlation", () => {
  it("attaches clientRequestId into AppError.details", () => {
    const enriched = attachRelayClientRequestIdToAppError(
      new AppError("fastPath is not allowed for streaming-capable RPC methods", {
        code: "BAD_REQUEST",
        statusCode: 400,
      }),
      "client-req-1",
    );

    expect(enriched.details).toEqual({ clientRequestId: "client-req-1" });
    expect(readRelayClientRequestIdFromError(enriched)).toBe("client-req-1");
  });

  it("preserves existing details when attaching", () => {
    const enriched = attachRelayClientRequestIdToAppError(
      new AppError("bad", {
        code: "BAD_REQUEST",
        statusCode: 400,
        details: { refundRelayRpcRequestRateLimit: true },
      }),
      "client-req-2",
    );

    expect(enriched.details).toEqual({
      refundRelayRpcRequestRateLimit: true,
      clientRequestId: "client-req-2",
    });
  });

  it("does not overwrite an existing clientRequestId", () => {
    const original = new AppError("bad", {
      code: "BAD_REQUEST",
      statusCode: 400,
      details: { clientRequestId: "already-set" },
    });
    const enriched = attachRelayClientRequestIdToAppError(original, "other-id");
    expect(enriched).toBe(original);
    expect(readRelayClientRequestIdFromError(enriched)).toBe("already-set");
  });

  it("wraps plain Error with clientRequestId for accepted echo", () => {
    const wrapped = ensureRelayClientRequestIdOnThrown(new Error("encode failed"), "client-req-3");
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.message).toBe("encode failed");
    expect(wrapped.code).toBe("INTERNAL_SERVER_ERROR");
    expect(wrapped.details).toEqual({ clientRequestId: "client-req-3" });
    expect(readRelayClientRequestIdFromError(wrapped)).toBe("client-req-3");
  });
});
