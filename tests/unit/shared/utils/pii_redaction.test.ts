import { describe, expect, it } from "vitest";

import { redactEmail, redactPhone } from "../../../../src/shared/utils/pii_redaction";

describe("pii_redaction", () => {
  it("redacts email local part", () => {
    expect(redactEmail("user@example.com")).toMatch(/\*.*@example\.com/);
    expect(redactEmail("ab@test.com")).toBe("***@test.com");
  });

  it("redacts phone middle", () => {
    expect(redactPhone("+5511987654321")).toContain("***");
    expect(redactPhone("+5511987654321").length).toBeLessThan("+5511987654321".length);
  });
});
