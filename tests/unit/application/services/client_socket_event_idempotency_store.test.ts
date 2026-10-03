import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildClientSocketEventPublishFingerprint,
  setClientSocketEventPublishIdempotencyEntry,
  getClientSocketEventPublishIdempotencyEntry,
  pruneClientSocketEventPublishIdempotencyEntries,
  resetClientSocketEventPublishIdempotencyStore,
  getClientSocketEventIdempotencyCardinality,
} from "../../../../src/application/services/client_socket_event_idempotency_store";

const config = vi.hoisted(() => ({
  restSocketEventIdempotencyTtlMs: 10,
  restSocketEventIdempotencyMaxEntries: 3,
}));
vi.mock("../../../../src/shared/config/env", () => ({ env: config }));
beforeEach(() => {
  resetClientSocketEventPublishIdempotencyStore();
  config.restSocketEventIdempotencyTtlMs = 10;
});
const entry = {
  fingerprint: "a",
  response: {
    success: true as const,
    eventId: "1",
    eventName: "client:custom.test",
    recipients: 0,
  },
};

describe("local idempotency expiry index", () => {
  it("preserves insertion-order eviction including overwrites at capacity", () => {
    for (const key of ["a", "b", "c"])
      setClientSocketEventPublishIdempotencyEntry("client", key, entry, 0);
    setClientSocketEventPublishIdempotencyEntry("client", "b", { ...entry, fingerprint: "b" }, 1);
    expect(getClientSocketEventPublishIdempotencyEntry("client", "a", 1)).toBeUndefined();
    expect(getClientSocketEventPublishIdempotencyEntry("client", "b", 1)?.fingerprint).toBe("b");
    expect(getClientSocketEventIdempotencyCardinality()).toEqual({ entries: 2, expirations: 2 });
    expect(pruneClientSocketEventPublishIdempotencyEntries(10)).toBe(1);
    expect(getClientSocketEventPublishIdempotencyEntry("client", "b", 11)).toBeUndefined();
    expect(getClientSocketEventIdempotencyCardinality()).toEqual({ entries: 0, expirations: 0 });
  });
  it("keeps one record for repeated renewal and clears both structures on reset", () => {
    for (let now = 0; now < 20_000; now++)
      setClientSocketEventPublishIdempotencyEntry("client", "a", entry, now);
    expect(getClientSocketEventIdempotencyCardinality()).toEqual({ entries: 1, expirations: 1 });
    resetClientSocketEventPublishIdempotencyStore();
    expect(getClientSocketEventIdempotencyCardinality()).toEqual({ entries: 0, expirations: 0 });
    config.restSocketEventIdempotencyTtlMs = 0;
    setClientSocketEventPublishIdempotencyEntry("client", "a", entry, 0);
    expect(getClientSocketEventIdempotencyCardinality().entries).toBe(0);
  });
});

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
