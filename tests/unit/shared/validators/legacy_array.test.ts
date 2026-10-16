import { describe, expect, it } from "vitest";
import { z } from "zod";
import { legacyArray } from "../../../../src/shared/validators/legacy_array";

describe("legacyArray public validation compatibility", () => {
  it("preserves fatal element issues before the size issue", () => {
    const result = legacyArray(z.string()).min(1).max(2).safeParse([123, "a", "b"]);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid oversized array");
    expect(result.error.issues).toEqual([
      {
        expected: "string",
        code: "invalid_type",
        path: [0],
        message: "Invalid input: expected string, received number",
      },
      {
        origin: "array",
        code: "too_big",
        maximum: 2,
        inclusive: true,
        path: [],
        message: "Too big: expected array to have <=2 items",
      },
    ]);
  });

  it.each([
    { value: [], accepted: false },
    { value: ["a"], accepted: true },
    { value: ["a", "b"], accepted: true },
    { value: ["a", "b", "c"], accepted: false },
    { value: "a", accepted: false },
    { value: null, accepted: false },
  ])("keeps the existing bounds for $value", ({ value, accepted }) => {
    expect(legacyArray(z.string()).min(1).max(2).safeParse(value).success).toBe(accepted);
  });

  it("preserves later refinement errors when the array exceeds its size limit", () => {
    const schema = legacyArray(z.string())
      .max(2)
      .superRefine((items, context) => {
        if (new Set(items).size !== items.length) {
          context.addIssue({ code: "custom", message: "Items must be unique" });
        }
      });

    const result = schema.safeParse(["a", "a", "a"]);

    expect(result.error?.issues.map(({ code, message }) => ({ code, message }))).toEqual([
      { code: "too_big", message: "Too big: expected array to have <=2 items" },
      { code: "custom", message: "Items must be unique" },
    ]);
  });

  it("preserves asynchronous element errors and their nested paths", async () => {
    const element = z.string().superRefine(async (value, context) => {
      await Promise.resolve();
      if (value === "invalid") context.addIssue({ code: "custom", message: "Invalid element" });
    });
    const schema = z.object({ items: legacyArray(element).max(2) });

    const result = await schema.safeParseAsync({ items: ["valid", "invalid", "valid"] });

    expect(
      result.error?.issues.map(({ code, path, message }) => ({ code, path, message })),
    ).toEqual([
      { code: "custom", path: ["items", 1], message: "Invalid element" },
      {
        code: "too_big",
        path: ["items"],
        message: "Too big: expected array to have <=2 items",
      },
    ]);
  });

  it("retains the published JSON Schema bounds and item types", () => {
    const schema = legacyArray(z.string()).min(1).max(2);

    expect(z.toJSONSchema(schema)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      minItems: 1,
      maxItems: 2,
      type: "array",
      items: { type: "string" },
    });
  });
});
