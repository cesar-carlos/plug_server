import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRestBenchTurnWaiter,
  RestBenchTurnCoordinator,
  startRestBenchCoordinator,
  type RestBenchLabel,
} from "../../performance/rest_api_bench_coordination";

afterEach(() => vi.unstubAllEnvs());

describe("REST benchmark paired repetitions", () => {
  it.each(["base", "head"] as const)(
    "should wait for both workers and serialize every sample with %s first",
    async (first) => {
      const coordinator = new RestBenchTurnCoordinator(first);
      const events: string[] = [];
      let active = 0;
      let peak = 0;
      const stages = ["catalog:warmup", "catalog:0", "catalog:1"];
      const worker = async (label: RestBenchLabel): Promise<void> => {
        for (const stage of stages) {
          await coordinator.wait(label, stage);
          events.push(`${label}:${stage}`);
          peak = Math.max(peak, ++active);
          await delay(1);
          active--;
        }
        await coordinator.wait(label, "complete");
      };
      await Promise.all([worker("base"), worker("head")]);
      const other = first === "base" ? "head" : "base";
      expect(events).toEqual([
        `${first}:catalog:warmup`,
        `${other}:catalog:warmup`,
        `${other}:catalog:0`,
        `${first}:catalog:0`,
        `${first}:catalog:1`,
        `${other}:catalog:1`,
      ]);
      expect(peak).toBe(1);
      expect(coordinator.completed).toBe(true);
      expect(coordinator.turns).toHaveLength(6);
      expect(coordinator.turns.every((turn) => turn.completedAt !== undefined)).toBe(true);
    },
  );

  it("should reject different stages instead of comparing different workloads", async () => {
    const coordinator = new RestBenchTurnCoordinator("base");
    const results = await Promise.allSettled([
      coordinator.wait("base", "catalog:warmup"),
      coordinator.wait("head", "registry:warmup"),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(coordinator.turns).toEqual([]);
    expect(coordinator.completed).toBe(false);
  });

  it("should abort both workers on duplicate requests or a peer failure", async () => {
    const coordinator = new RestBenchTurnCoordinator("base");
    const results = await Promise.allSettled([
      coordinator.wait("base", "catalog:warmup"),
      coordinator.wait("base", "catalog:warmup"),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    await expect(coordinator.wait("head", "catalog:warmup")).rejects.toThrow("Duplicate");
    expect(coordinator.completed).toBe(false);
  });

  it("should authenticate loopback turns and finish before either worker cleans up", async () => {
    const server = await startRestBenchCoordinator("base");
    try {
      const invalid = await fetch(`${server.url}/turn?label=base&stage=catalog:warmup`);
      expect(invalid.status).toBe(400);
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("REST_BENCH_ISOLATED_DATABASE", "true");
      vi.stubEnv("REST_BENCH_COORDINATOR_URL", server.url);
      vi.stubEnv("REST_BENCH_COORDINATOR_TOKEN", server.token);
      vi.stubEnv("REST_BENCH_COORDINATOR_LABEL", "base");
      const base = createRestBenchTurnWaiter();
      vi.stubEnv("REST_BENCH_COORDINATOR_LABEL", "head");
      const head = createRestBenchTurnWaiter();
      let measured = 0;
      await Promise.all(
        [base, head].map(async (wait) => {
          await wait("catalog:warmup");
          await wait("catalog:0");
          measured++;
          await wait("complete");
          expect(measured).toBe(2);
        }),
      );
      expect(server.coordinator.completed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("should refuse coordinator endpoints outside isolated loopback tests", () => {
    vi.stubEnv("REST_BENCH_COORDINATOR_URL", "https://example.com");
    expect(createRestBenchTurnWaiter).toThrow("isolated loopback test endpoint");
  });
});
