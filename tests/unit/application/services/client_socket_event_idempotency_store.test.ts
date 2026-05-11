import { describe, expect, it } from "vitest";

import { buildClientSocketEventPublishFingerprint } from "../../../../src/application/services/client_socket_event_idempotency_store";

describe("buildClientSocketEventPublishFingerprint", () => {
  it("returns stable hex for the same logical body", () => {
    const body = {
      eventName: "client:custom.unit.fp",
      payload: { a: 1 },
      attachments: [] as const,
    };
    expect(buildClientSocketEventPublishFingerprint(body)).toBe(
      buildClientSocketEventPublishFingerprint(body),
    );
  });

  it("throws VALIDATION_ERROR when payload is not JSON-serializable", () => {
    expect(() =>
      buildClientSocketEventPublishFingerprint({
        eventName: "client:custom.bad",
        payload: { x: BigInt(1) } as unknown,
        attachments: [],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
      }),
    );
  });
});
