import { afterEach, expect, it, vi } from "vitest";

import { runSocketBridgeBench } from "../../performance/socket_bridge_bench_harness";

afterEach(() => vi.unstubAllGlobals());

it("should reject memory measurements when explicit GC is unavailable in the worker", async () => {
  vi.stubGlobal("gc", undefined);

  await expect(runSocketBridgeBench()).rejects.toThrow(
    "Socket benchmark requires explicit GC in the test worker",
  );
});
