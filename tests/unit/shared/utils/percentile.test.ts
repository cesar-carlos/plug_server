import { describe, expect, it } from "vitest";

import { percentile } from "../../../../src/shared/utils/percentile";

describe("percentile (quickselect)", () => {
  it("should preserve nearest-rank results and inputs across repeated and ordered distributions", () => {
    let seed = 42;
    for (const length of [1, 2, 3, 31, 256, 1024]) {
      const random = Array.from({ length }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (seed % 41) - 20;
      });
      for (const values of [
        random,
        [...random].sort((a, b) => a - b),
        [...random].sort((a, b) => b - a),
        Array.from({ length }, () => 7),
      ]) {
        const original = [...values];
        const sorted = [...values].sort((a, b) => a - b);
        for (const p of [-1, 0, 1, 25, 50, 95, 99, 100, 101]) {
          const rank = Math.min(length - 1, Math.max(0, Math.ceil((p / 100) * length) - 1));
          expect(percentile(values, p)).toBe(sorted[rank]);
        }
        expect(values).toEqual(original);
      }
    }
  });

  it("should return 0 for empty input", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("should match sorted-rank behavior for small sets", () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 100)).toBe(50);
  });
});
