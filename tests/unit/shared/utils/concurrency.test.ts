import { describe, expect, it } from "vitest";

import { forEachWithConcurrencyLimit } from "../../../../src/shared/utils/concurrency";

describe("forEachWithConcurrencyLimit", () => {
  it("runs all items with bounded concurrency", async () => {
    const order: number[] = [];
    const items = [1, 2, 3, 4, 5];

    await forEachWithConcurrencyLimit(items, 2, async (item) => {
      order.push(item);
      await Promise.resolve();
    });

    expect(order.sort((left, right) => left - right)).toEqual(items);
  });
});
