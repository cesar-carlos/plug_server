import { describe, it, expect } from "vitest";

import {
  uuidSchema,
  emailSchema,
  passwordSchema,
  usernameSchema,
  isoDateSchema,
  positiveIntSchema,
  nonEmptyStringSchema,
  paginationSchema,
  idParamSchema,
} from "../../../../src/shared/validators/schemas";

describe("uuidSchema", () => {
  it("should accept a valid UUID", () => {
    expect(() => uuidSchema.parse("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  it("should reject a non-UUID string", () => {
    expect(() => uuidSchema.parse("not-a-uuid")).toThrow("Must be a valid UUID");
  });
});

describe("emailSchema", () => {
  it("should accept a valid email and lowercase it", () => {
    expect(emailSchema.parse("User@Example.COM")).toBe("user@example.com");
  });

  it("should reject an invalid email", () => {
    expect(() => emailSchema.parse("not-an-email")).toThrow("Must be a valid email address");
  });
});

describe("passwordSchema", () => {
  it("should accept a strong password", () => {
    expect(() => passwordSchema.parse("Secure1Pass")).not.toThrow();
  });

  it("should reject a password shorter than 8 characters", () => {
    expect(() => passwordSchema.parse("Ab1!")).toThrow("at least 8 characters");
  });

  it("should reject a password without an uppercase letter", () => {
    expect(() => passwordSchema.parse("secure1pass")).toThrow("uppercase letter");
  });

  it("should reject a password without a number", () => {
    expect(() => passwordSchema.parse("SecurePass")).toThrow("one number");
  });
});

describe("usernameSchema", () => {
  it("should accept a valid username", () => {
    expect(() => usernameSchema.parse("user_123")).not.toThrow();
  });

  it("should reject a username shorter than 3 characters", () => {
    expect(() => usernameSchema.parse("ab")).toThrow("at least 3 characters");
  });

  it("should reject a username with special characters", () => {
    expect(() => usernameSchema.parse("user@name!")).toThrow("letters, numbers");
  });
});

describe("isoDateSchema", () => {
  it("should accept a valid ISO 8601 datetime", () => {
    expect(() => isoDateSchema.parse("2026-03-16T18:00:00.000Z")).not.toThrow();
  });

  it("should reject a plain date string without time", () => {
    expect(() => isoDateSchema.parse("2026-03-16")).toThrow();
  });

  it("should reject a non-date string", () => {
    expect(() => isoDateSchema.parse("not-a-date")).toThrow();
  });
});

describe("positiveIntSchema", () => {
  it("should accept a positive integer", () => {
    expect(() => positiveIntSchema.parse(5)).not.toThrow();
  });

  it("should reject zero", () => {
    expect(() => positiveIntSchema.parse(0)).toThrow("positive");
  });

  it("should reject a float", () => {
    expect(() => positiveIntSchema.parse(1.5)).toThrow("integer");
  });

  it("should reject a negative number", () => {
    expect(() => positiveIntSchema.parse(-1)).toThrow("positive");
  });
});

describe("nonEmptyStringSchema", () => {
  it("should accept a non-empty string", () => {
    expect(() => nonEmptyStringSchema.parse("hello")).not.toThrow();
  });

  it("should reject an empty string", () => {
    expect(() => nonEmptyStringSchema.parse("")).toThrow("Must not be empty");
  });

  it("should trim whitespace", () => {
    expect(nonEmptyStringSchema.parse("  hello  ")).toBe("hello");
  });
});

describe("paginationSchema", () => {
  it("should use defaults when fields are omitted", () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it("should coerce string numbers from query params", () => {
    expect(paginationSchema.parse({ page: "2", limit: "10" })).toEqual({ page: 2, limit: 10 });
  });

  it("should reject a limit above 100", () => {
    expect(() => paginationSchema.parse({ limit: 101 })).toThrow("at most 100");
  });

  it("should reject page zero", () => {
    expect(() => paginationSchema.parse({ page: 0 })).toThrow();
  });
});

describe("idParamSchema", () => {
  it("should accept a valid UUID param", () => {
    expect(() => idParamSchema.parse({ id: "550e8400-e29b-41d4-a716-446655440000" })).not.toThrow();
  });

  it("should reject a non-UUID param", () => {
    expect(() => idParamSchema.parse({ id: "abc" })).toThrow("Must be a valid UUID");
  });
});
