import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  flushPendingBridgeLatencyTraces,
  enqueueBridgeLatencyTrace,
  resetBridgeLatencyTraceServiceForTests,
} from "../../src/application/services/bridge_latency_trace.service";
import { prismaClient } from "../../src/infrastructure/database/prisma/client";

describe("bridge_latency_traces (integration)", () => {
  let tableAvailable = false;

  beforeAll(async () => {
    resetBridgeLatencyTraceServiceForTests();
    try {
      const rows = await prismaClient.$queryRaw<Array<{ exists: boolean }>>`
        SELECT to_regclass('public.bridge_latency_traces') IS NOT NULL AS "exists"
      `;
      tableAvailable = rows[0]?.exists === true;
    } catch {
      tableAvailable = false;
    }
  });

  afterAll(async () => {
    resetBridgeLatencyTraceServiceForTests();
  });

  it("persists a row after enqueue + flush when table exists", async () => {
    if (!tableAvailable) {
      return;
    }

    const id = randomUUID();
    enqueueBridgeLatencyTrace({
      id,
      channel: "rest",
      requestId: "integration-req",
      traceId: "integration-trace",
      agentId: "00000000-0000-0000-0000-000000000001",
      userId: null,
      jsonRpcMethod: "sql.execute",
      totalMs: 99,
      phasesSumMs: 50,
      phasesSchemaVersion: 1,
      phasesMs: { transform_ms: 50 },
      outcome: "success",
      httpStatus: 200,
      errorCode: null,
    });

    await flushPendingBridgeLatencyTraces();

    const row = await prismaClient.bridgeLatencyTrace.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.totalMs).toBe(99);
    expect(row?.phasesSumMs).toBe(50);
    expect(row?.phasesSchemaVersion).toBe(1);

    await prismaClient.bridgeLatencyTrace.delete({ where: { id } });
  });
});
