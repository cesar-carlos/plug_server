import { describe, expect, it } from "vitest";

import {
  brazilianCelularSchema,
  optionalBrazilianCelularSchema,
} from "../../../../src/shared/validators/schemas";

describe("optionalBrazilianCelularSchema", () => {
  it("accepts absent value", () => {
    const r = optionalBrazilianCelularSchema.safeParse(undefined);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBeUndefined();
  });

  it("normalizes a valid BR mobile to E.164", () => {
    const r = optionalBrazilianCelularSchema.safeParse("11987654321");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatch(/^\+55\d{10,11}$/);
  });

  it("accepts E.164 +55 and spaced national formats", () => {
    const a = optionalBrazilianCelularSchema.safeParse("+55 11 98765-4321");
    expect(a.success).toBe(true);
    const b = optionalBrazilianCelularSchema.safeParse("(11) 98765-4321");
    expect(b.success).toBe(true);
    if (a.success && b.success) expect(a.data).toBe(b.data);
  });

  it("rejects landline", () => {
    const r = optionalBrazilianCelularSchema.safeParse("1133334444");
    expect(r.success).toBe(false);
  });

  it("rejects invalid input", () => {
    const r = optionalBrazilianCelularSchema.safeParse("not-a-phone");
    expect(r.success).toBe(false);
  });
});

describe("brazilianCelularSchema", () => {
  it("rejects empty string", () => {
    const r = brazilianCelularSchema.safeParse("");
    expect(r.success).toBe(false);
  });
});
