import { describe, expect, it } from "vitest";

import {
  resolveConsumerClientAgentRoomReconcileStartDelayMs,
  selectReconcileClientEntries,
} from "../../src/socket";

describe("socket reconcile scheduling helpers", () => {
  it("selects a bounded batch and advances the cursor rotatively", () => {
    const first = selectReconcileClientEntries(["a", "b", "c", "d"], 1, 2);
    expect(first.selected).toEqual(["b", "c"]);
    expect(first.nextCursor).toBe(3);
    expect(first.deferredCount).toBe(2);

    const second = selectReconcileClientEntries(["a", "b", "c", "d"], first.nextCursor, 2);
    expect(second.selected).toEqual(["d", "a"]);
    expect(second.nextCursor).toBe(1);
    expect(second.deferredCount).toBe(2);
  });

  it("handles empty input and clamps the reconcile start jitter", () => {
    expect(selectReconcileClientEntries([], 7, 3)).toEqual({
      selected: [],
      nextCursor: 0,
      deferredCount: 0,
    });
    expect(resolveConsumerClientAgentRoomReconcileStartDelayMs(0, 0.5)).toBe(0);
    expect(resolveConsumerClientAgentRoomReconcileStartDelayMs(1000, -1)).toBe(0);
    expect(resolveConsumerClientAgentRoomReconcileStartDelayMs(1000, 0.5)).toBe(500);
    expect(resolveConsumerClientAgentRoomReconcileStartDelayMs(1000, 99)).toBe(1001);
  });

  it("preserves cursor normalization and fractional slice semantics", () => {
    expect(selectReconcileClientEntries(["a", "b", "c"], -1, 2)).toEqual({
      selected: ["c", "a"],
      nextCursor: 1,
      deferredCount: 1,
    });
    expect(selectReconcileClientEntries(["a", "b", "c"], 4.5, 1.5)).toEqual({
      selected: ["b"],
      nextCursor: 0,
      deferredCount: 1.5,
    });
    expect(selectReconcileClientEntries(["a", "b"], Number.NaN, 1).selected).toEqual(["a"]);
  });
});
