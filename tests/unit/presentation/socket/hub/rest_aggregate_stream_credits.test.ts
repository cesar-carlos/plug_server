import { describe, expect, it } from "vitest";

import { stepRestSqlStreamMaterializeCredits } from "../../../../../src/presentation/socket/hub/rest_sql_stream_materialize";

/**
 * Simulates initial pull + chunk sequence using the same pure step as production.
 */
const countPullsForChunks = (chunkCount: number, window: number): number => {
  let pulls = 0;
  let stored: number | undefined = undefined;
  const initialPull = (): void => {
    pulls += 1;
    stored = window;
  };
  initialPull();
  for (let i = 0; i < chunkCount; i += 1) {
    const { nextStoredCredits, shouldEmitPull } = stepRestSqlStreamMaterializeCredits(stored, window);
    stored = nextStoredCredits;
    if (shouldEmitPull) {
      pulls += 1;
    }
  }
  return pulls;
};

describe("stepRestSqlStreamMaterializeCredits / pull count", () => {
  it("should use one pull when no chunks (only initial grant)", () => {
    expect(countPullsForChunks(0, 32)).toBe(1);
  });

  it("should use one pull when chunks fit in first window", () => {
    expect(countPullsForChunks(10, 32)).toBe(1);
  });

  it("should add a pull when chunks exceed one window", () => {
    expect(countPullsForChunks(32, 32)).toBe(2);
    expect(countPullsForChunks(33, 32)).toBe(2);
    expect(countPullsForChunks(64, 32)).toBe(3);
  });

  it("should match per-chunk pulls for window 1", () => {
    expect(countPullsForChunks(5, 1)).toBe(6);
  });

  it("should document single step transitions", () => {
    expect(stepRestSqlStreamMaterializeCredits(32, 32)).toEqual({
      nextStoredCredits: 31,
      shouldEmitPull: false,
    });
    expect(stepRestSqlStreamMaterializeCredits(1, 32)).toEqual({
      nextStoredCredits: 32,
      shouldEmitPull: true,
    });
  });
});
