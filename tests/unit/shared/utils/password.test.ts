import { describe, expect, it } from "vitest";
import { comparePassword, hashPassword } from "../../../../src/shared/utils/password";
import fixtures from "../../../fixtures/password_legacy_hashes.json";

describe("password helper legacy compatibility", () => {
  it.each(fixtures)("preserves verification of a frozen 1.10.9 hash: $hash", async (fixture) => {
    expect(await comparePassword(fixture.password, fixture.hash)).toBe(fixture.valid);
    expect(await comparePassword("!" + fixture.password, fixture.hash)).toBe(fixture.invalid);
  });

  it("keeps cost 10, random salts and the existing 72-byte truncation", async () => {
    const password = "a".repeat(72);
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).toMatch(/^\$2b\$10\$/);
    expect(first).not.toBe(second);
    expect(await comparePassword(password + "suffix", first)).toBe(true);
  });
});
