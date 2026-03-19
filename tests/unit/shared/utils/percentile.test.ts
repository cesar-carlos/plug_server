import { describe, expect, it } from "vitest";

import { percentile } from "../../../../src/shared/utils/percentile";

describe("percentile (quickselect)", () => {
  it("should return 0 for empty input", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("should match sorted-rank behavior for small sets", () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 100)).toBe(50);
  });
});
