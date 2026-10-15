import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runRestApiBench } from "./rest_api_bench_harness";
import { restApiBenchComparisonErrors } from "./rest_api_bench_reports";

// Access-log formatting is outside the measured request pipeline.
vi.mock("morgan", () => ({
  default: Object.assign(() => (_req: unknown, _res: unknown, next: () => void) => next(), {
    token: () => undefined,
  }),
}));

describe("REST API transport benchmark", () => {
  it("preserves responses and compares identical profiles", async () => {
    const report = await runRestApiBench();
    const reportPath = process.env.REST_API_BENCH_REPORT_PATH ?? "tmp/rest-api-bench.json";
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    const baselinePath = process.env.REST_API_BENCH_BASELINE_PATH;
    const baseline = baselinePath ? JSON.parse(await readFile(baselinePath, "utf8")) : undefined;
    expect(restApiBenchComparisonErrors(report, baseline)).toEqual([]);
  });
});
