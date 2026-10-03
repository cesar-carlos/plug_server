import { writeFileSync, mkdirSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { runLoopbackRelayBench } from "./socket_bridge_loopback_bench";

describe("new columnar loopback scenarios", () => {
  it("delivers equivalent row maps without loss and drains slow consumers", async () => {
    const results = [];
    for (const fastPath of [false, true]) {
      for (const slow of [false, true]) {
        await runLoopbackRelayBench(2, 8, slow, true, fastPath);
        const repetitions = [];
        for (let i = 0; i < 9; i++) {
          global.gc?.();
          const delay = monitorEventLoopDelay({ resolution: 1 });
          delay.enable();
          const cpuStart = process.cpuUsage();
          const heapStart = process.memoryUsage().heapUsed;
          try {
            const result = await runLoopbackRelayBench(12, 8, slow, true, fastPath);
            expect(result.chunksLost).toBe(0);
            expect(result.duplicateChunks).toBe(0);
            expect(result.orderOk).toBe(true);
            repetitions.push({
              ...result,
              cpu: process.cpuUsage(cpuStart),
              rssBytes: process.memoryUsage().rss,
              heapGrowthBytes: process.memoryUsage().heapUsed - heapStart,
              eventLoopDelayP95Ms: delay.count > 0 ? delay.percentile(95) / 1e6 : 0,
            });
          } finally {
            delay.disable();
          }
        }
        results.push({ fastPath, slow, repetitions });
      }
    }
    mkdirSync("tmp", { recursive: true });
    writeFileSync(
      "tmp/socket-columnar-bench.json",
      JSON.stringify(
        {
          harnessVersion: 1,
          nodeVersion: process.version,
          platform: process.platform,
          config: { iterations: 12, chunks: 8, repeats: 9 },
          comparableWithOldRejectedFrames: false,
          results,
        },
        null,
        2,
      ),
    );
  });
});
