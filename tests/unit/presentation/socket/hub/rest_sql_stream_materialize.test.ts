import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REST_STREAM_AGGREGATE_CONSUMER_ID,
  restSqlStreamMaterializeClearRequest,
  restSqlStreamMaterializeConsumeChunk,
  restSqlStreamMaterializeReset,
  restSqlStreamMaterializeSeedCredits,
  stepRestSqlStreamMaterializeCredits,
} from "../../../../../src/presentation/socket/hub/relay/rest_sql_stream_materialize";

describe("rest_sql_stream_materialize", () => {
  afterEach(() => {
    restSqlStreamMaterializeReset();
  });

  it("exports the REST aggregate consumer id constant", () => {
    expect(REST_STREAM_AGGREGATE_CONSUMER_ID).toBe("__plug_rest_sql_stream_aggregate__");
  });

  describe("stepRestSqlStreamMaterializeCredits", () => {
    it("should emit pull when stored credits are exhausted", () => {
      expect(stepRestSqlStreamMaterializeCredits(1, 16)).toEqual({
        nextStoredCredits: 16,
        shouldEmitPull: true,
      });
    });

    it("should decrement without pull while credits remain", () => {
      expect(stepRestSqlStreamMaterializeCredits(4, 16)).toEqual({
        nextStoredCredits: 3,
        shouldEmitPull: false,
      });
    });

    it("should treat missing stored credits as zero before the first pull", () => {
      expect(stepRestSqlStreamMaterializeCredits(undefined, 8)).toEqual({
        nextStoredCredits: 8,
        shouldEmitPull: true,
      });
    });
  });

  describe("mutable store helpers", () => {
    it("seeds credits for a request id", () => {
      restSqlStreamMaterializeSeedCredits("req-seed", 12);
      const emitPull = vi.fn();

      restSqlStreamMaterializeConsumeChunk("req-seed", 12, emitPull);

      expect(emitPull).not.toHaveBeenCalled();
    });

    it("invokes emitPull when the credit window is exhausted", () => {
      restSqlStreamMaterializeSeedCredits("req-pull", 2);
      const emitPull = vi.fn();

      restSqlStreamMaterializeConsumeChunk("req-pull", 16, emitPull);
      expect(emitPull).not.toHaveBeenCalled();

      restSqlStreamMaterializeConsumeChunk("req-pull", 16, emitPull);
      expect(emitPull).toHaveBeenCalledTimes(1);
    });

    it("clears a single request without affecting others", () => {
      restSqlStreamMaterializeSeedCredits("req-a", 1);
      restSqlStreamMaterializeSeedCredits("req-b", 2);
      const emitPullA = vi.fn();
      const emitPullB = vi.fn();

      restSqlStreamMaterializeClearRequest("req-a");

      restSqlStreamMaterializeConsumeChunk("req-a", 8, emitPullA);
      expect(emitPullA).toHaveBeenCalledTimes(1);

      restSqlStreamMaterializeConsumeChunk("req-b", 8, emitPullB);
      expect(emitPullB).not.toHaveBeenCalled();
    });

    it("reset clears all seeded requests", () => {
      restSqlStreamMaterializeSeedCredits("req-reset", 1);
      restSqlStreamMaterializeReset();
      const emitPull = vi.fn();

      restSqlStreamMaterializeConsumeChunk("req-reset", 8, emitPull);
      expect(emitPull).toHaveBeenCalledTimes(1);
    });
  });
});
