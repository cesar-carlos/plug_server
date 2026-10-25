import express from "express";
import request from "supertest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { container } from "../../src/shared/di/container";
import { agentRegistry } from "../../src/presentation/socket/hub/registries/agent_registry";
import { listConnectedAgents } from "../../src/presentation/http/controllers/agents.controller";

afterEach(() => {
  vi.restoreAllMocks();
  agentRegistry.clear();
});

it("measures connected-agent listing over HTTP with fixed authorization results", async () => {
  // Isolate listing/projection/serialization/HTTP; JWT and database latency are outside this benchmark.
  const allowed = Array.from({ length: 10 }, (_, i) => `agent-${i * 3}`).reverse();
  vi.spyOn(container.userAgentService, "listAgentIdsByUserId").mockResolvedValue(allowed);
  let mode: "legacy" | "optimized" = "legacy";
  const originalList = container.restAgentBridgeService.listConnectedAgents.bind(
    container.restAgentBridgeService,
  );
  // Replay the previous project-all-then-filter path in the same process to control host/JIT noise.
  vi.spyOn(container.restAgentBridgeService, "listConnectedAgents").mockImplementation((ids) =>
    originalList(mode === "legacy" ? undefined : ids),
  );
  const app = express();
  app.set("etag", false);
  for (const role of ["user", "admin"])
    app.get(
      `/${role}`,
      (_req, res, next) => {
        res.locals.authUser = { sub: "benchmark-user", role };
        res.locals.validated = { query: {} };
        next();
      },
      listConnectedAgents,
    );
  const iterations = 30;
  const results: {
    connected: number;
    role: string;
    mode: string;
    returned: number;
    samplesMs: number[];
    medianMs: number;
  }[] = [];
  for (const [connected, role] of [
    [100, "user"],
    [1000, "user"],
    [10000, "user"],
    [10000, "admin"],
  ] as const) {
    agentRegistry.clear();
    for (let i = 0; i < connected; i += 1)
      agentRegistry.upsert({
        agentId: `agent-${i}`,
        socketId: `socket-${i}`,
        userId: null,
        capabilities: { compressions: ["none", "gzip"] },
      });
    const expectedIds = role === "admin" ? agentRegistry.listIds() : [...allowed].reverse();
    const samplesByMode: Record<"legacy" | "optimized", number[]> = { legacy: [], optimized: [] };
    for (let repeat = 0; repeat < 9; repeat += 1) {
      const modes =
        repeat % 2 === 0 ? (["legacy", "optimized"] as const) : (["optimized", "legacy"] as const);
      for (const currentMode of modes) {
        mode = currentMode;
        const start = performance.now();
        for (let i = 0; i < iterations; i += 1) {
          const response = await request(app).get(`/${role}`);
          expect(response.status).toBe(200);
          expect(response.body.count).toBe(expectedIds.length);
          expect(response.body.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(
            expectedIds,
          );
          expect(response.body.agents[0]).not.toHaveProperty("socketId");
        }
        const elapsed = performance.now() - start;
        if (repeat >= 2) samplesByMode[mode].push(elapsed);
      }
    }
    const first = await request(app).get(`/${role}`);
    const etag = first.headers.etag;
    if (typeof etag !== "string") throw new Error("Missing listing ETag");
    const cached = await request(app).get(`/${role}`).set("If-None-Match", etag);
    expect(cached.status).toBe(304);
    expect(cached.headers.etag).toBe(first.headers.etag);
    for (const currentMode of ["legacy", "optimized"] as const)
      results.push({
        connected,
        role,
        mode: currentMode,
        returned: expectedIds.length,
        samplesMs: samplesByMode[currentMode],
        medianMs: [...samplesByMode[currentMode]].sort((a, b) => a - b)[3]!,
      });
  }
  const output = process.env.REST_CONNECTED_BENCH_REPORT ?? "tmp/rest-connected-bench.json";
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      { nodeVersion: process.version, platform: process.platform, iterations, results },
      null,
      2,
    ),
  );
}, 120_000);
