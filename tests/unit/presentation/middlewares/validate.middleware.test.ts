import { describe, it, expect } from "vitest";
import { z } from "zod";

import { normalizeZodIssues } from "../../../../src/presentation/http/middlewares/validate.middleware";

describe("normalizeZodIssues", () => {
  it("should normalize a nested field path", () => {
    const schema = z.object({ user: z.object({ email: z.string().email() }) });
    const result = schema.safeParse({ user: { email: "bad" } });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = normalizeZodIssues(result.error);
      expect(issues[0]).toMatchObject({ field: "user.email" });
    }
  });

  it("should use 'root' as field when path is empty", () => {
    const schema = z.string().min(1);
    const result = schema.safeParse("");

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = normalizeZodIssues(result.error);
      expect(issues[0]?.field).toBe("root");
    }
  });

  it("should include the message from the schema", () => {
    const schema = z.object({ name: z.string().min(3, "Too short") });
    const result = schema.safeParse({ name: "ab" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = normalizeZodIssues(result.error);
      expect(issues[0]).toMatchObject({ field: "name", message: "Too short" });
    }
  });

  it("should return one entry per issue when multiple fields fail", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({ a: 1, b: "x" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = normalizeZodIssues(result.error);
      expect(issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
