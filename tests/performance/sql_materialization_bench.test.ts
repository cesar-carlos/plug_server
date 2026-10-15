import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { inspectSqlStreamChunk } from "../../src/infrastructure/codecs/sql_stream_chunk_inspection";
import { normalizeColumnarSqlChunk } from "../../src/infrastructure/codecs/sql_stream_chunk_codec";
import * as mergeModule from "../../src/application/agent_commands/merge_sql_stream_rpc_response";

// Synthetic protocol work only: no database, native agent or shared fixture.
it("measures exact columnar normalization and REST completion", () => {
  const phase = process.env.HUB_MATERIALIZATION_BENCH_PHASE ?? "after";
  if (!["before", "after"].includes(phase)) throw new Error("Invalid benchmark phase");
  const reports = [];
  for (const [name, rowCount, width, textual] of [
    ["numeric", 2000, 16, false],
    ["wide", 1000, 64, false],
    ["unicode", 2000, 16, true],
  ] as const) {
    const chunk = {
      stream_id: "synthetic",
      request_id: "r",
      chunk_index: 0,
      rows: [],
      columnar: {
        row_count: rowCount,
        columns: Array.from({ length: width }, (_, column) => ({
          name: `c${column}`,
          type: "object",
          values: Array.from({ length: rowCount }, (_, row) =>
            row % 7 === 0 ? null : textual ? `ação 🎉 ${row}` : row + column / 10,
          ),
        })),
      },
    };
    const run = (): ReturnType<typeof normalizeColumnarSqlChunk> => {
      const inspection = inspectSqlStreamChunk(chunk);
      if (!inspection.ok) throw new Error(inspection.message);
      return normalizeColumnarSqlChunk(
        chunk,
        { maxRows: 50000, maxBytes: 10000000 },
        undefined,
        inspection,
      );
    };
    const expected = run()!;
    expect(expected.originalSizeBytes).toBe(Buffer.byteLength(JSON.stringify(expected.payload)));
    const samples = [];
    for (let sample = -2; sample < 9; sample++) {
      global.gc?.();
      const heap = process.memoryUsage().heapUsed;
      const cpu = process.cpuUsage();
      const start = performance.now();
      for (let iteration = 0; iteration < 12; iteration++) run();
      if (sample >= 0)
        samples.push({
          ms: (performance.now() - start) / 12,
          cpu: process.cpuUsage(cpu),
          heapGrowthBytes: process.memoryUsage().heapUsed - heap,
        });
    }
    reports.push({
      name,
      rowCount,
      width,
      samples,
      outputHash: createHash("sha256").update(JSON.stringify(expected.payload)).digest("hex"),
    });
  }
  const merge =
    (
      mergeModule as typeof mergeModule & {
        mergeSqlStreamRpcResponseWithOwnedRows?: typeof mergeModule.mergeSqlStreamRpcResponseWithAppendedRows;
      }
    ).mergeSqlStreamRpcResponseWithOwnedRows ??
    mergeModule.mergeSqlStreamRpcResponseWithAppendedRows;
  const source = Array.from({ length: 100000 }, (_, id) => ({ id }));
  const initial = {
    jsonrpc: "2.0",
    id: "r",
    result: { rows: [], stream_id: "s", affected_rows: null },
  };
  const complete = { total_rows: source.length };
  const samples = [];
  for (let sample = -2; sample < 9; sample++) {
    const accumulators = Array.from({ length: 12 }, () => source.slice());
    global.gc?.();
    const heap = process.memoryUsage().heapUsed;
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (const accumulator of accumulators) merge(initial, accumulator, complete);
    if (sample >= 0)
      samples.push({
        ms: (performance.now() - start) / 12,
        cpu: process.cpuUsage(cpu),
        heapGrowthBytes: process.memoryUsage().heapUsed - heap,
      });
  }
  const merged = merge(initial, source.slice(), complete);
  expect(merged).toEqual(
    mergeModule.mergeSqlStreamRpcResponseWithAppendedRows(initial, source, complete),
  );
  reports.push({
    name: "rest-completion",
    rowCount: source.length,
    width: 1,
    samples,
    outputHash: createHash("sha256").update(JSON.stringify(merged)).digest("hex"),
  });
  const files = [
    "src/infrastructure/codecs/sql_stream_chunk_inspection.ts",
    "src/infrastructure/codecs/sql_stream_chunk_codec.ts",
    "src/application/agent_commands/merge_sql_stream_rpc_response.ts",
  ];
  mkdirSync("tmp", { recursive: true });
  writeFileSync(
    `tmp/sql-materialization-${phase}.json`,
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        phase,
        repetitions: 9,
        iterations: 12,
        files: files.map((path) => ({
          path,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        })),
        reports,
      },
      null,
      2,
    ),
  );
});
