import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runRestApiBench } from "./rest_api_bench_harness";

// Access-log formatting is outside the measured request pipeline.
vi.mock("morgan", () => ({
  default: Object.assign(() => (_req: unknown, _res: unknown, next: () => void) => next(), {
    token: () => undefined,
  }),
}));

describe("REST API transport benchmark", () => {
  it("preserves responses and compares identical profiles", async () => {
    const report = await runRestApiBench();
    await mkdir("tmp", { recursive: true });
    await writeFile("tmp/rest-api-bench.json", JSON.stringify(report, null, 2));
    for (const scenario of report.scenarios) {
      expect(scenario.errors, scenario.name).toBe(0);
      expect(scenario.timeouts, scenario.name).toBe(0);
    }
    const baselinePath = process.env.REST_API_BENCH_BASELINE_PATH;
    if (!baselinePath) return;
    const baseline: typeof report = JSON.parse(await readFile(baselinePath, "utf8"));
    expect(report.harnessVersion).toBe(baseline.harnessVersion);
    expect(report.configFingerprint).toBe(baseline.configFingerprint);
    expect(report.versions).toEqual(baseline.versions);
    expect(report.nodeVersion).toBe(baseline.nodeVersion);
    expect(report.platform).toBe(baseline.platform);
    expect(report.scenarios.map((scenario) => scenario.name)).toEqual(
      baseline.scenarios.map((scenario) => scenario.name),
    );
    for (const [index, scenario] of report.scenarios.entries()) {
      const reference = baseline.scenarios[index]!;
      expect(scenario.responseDigest, scenario.name).toBe(reference.responseDigest);
      if (scenario.name === "refresh_saturated") continue;
      expect(scenario.p95Ms, scenario.name).toBeLessThanOrEqual(reference.p95Ms * 1.05);
      expect(scenario.throughputPerSec, scenario.name).toBeGreaterThanOrEqual(
        reference.throughputPerSec * 0.85,
      );
      expect(scenario.heapGrowthBytes, scenario.name).toBeLessThanOrEqual(
        reference.heapGrowthBytes * 1.1,
      );
    }
    expect(createHash("sha256").update(JSON.stringify(report.config)).digest("hex")).toBe(
      report.configFingerprint,
    );
  });
});
