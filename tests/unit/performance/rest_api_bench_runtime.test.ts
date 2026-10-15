import { afterEach, expect, it, vi } from "vitest";

import { runRestApiBench } from "../../performance/rest_api_bench_harness";

afterEach(() => vi.unstubAllGlobals());

it("should reject REST memory measurements without explicit GC", async () => {
  vi.stubGlobal("gc", undefined);
  await expect(runRestApiBench()).rejects.toThrow("explicit GC in the test worker");
});

it("should reject adaptive GC before setting up benchmark data", async () => {
  vi.stubGlobal("gc", () => undefined);
  const originalArgs = process.execArgv;
  process.execArgv = ["--expose-gc"];
  try {
    await expect(runRestApiBench()).rejects.toThrow("predictable GC in the test worker");
  } finally {
    process.execArgv = originalArgs;
  }
});
