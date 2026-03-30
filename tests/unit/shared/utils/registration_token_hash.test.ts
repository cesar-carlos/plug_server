import { describe, expect, it } from "vitest";

import { hashRegistrationToken } from "../../../../src/shared/utils/registration_token_hash";

describe("hashRegistrationToken", () => {
  it("returns deterministic sha256 hex hash", () => {
    const token = "opaque-token-123";
    const first = hashRegistrationToken(token);
    const second = hashRegistrationToken(token);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hash for different inputs", () => {
    const one = hashRegistrationToken("opaque-token-a");
    const two = hashRegistrationToken("opaque-token-b");

    expect(one).not.toBe(two);
  });
});
