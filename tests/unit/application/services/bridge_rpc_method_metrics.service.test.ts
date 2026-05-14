import { afterEach, describe, expect, it } from "vitest";

import {
  getBridgeRpcMethodMetricsSnapshot,
  observeBridgeRpcMethod,
  resetBridgeRpcMethodMetrics,
} from "../../../../src/application/services/bridge_rpc_method_metrics.service";

describe("bridge_rpc_method_metrics", () => {
  afterEach(() => {
    resetBridgeRpcMethodMetrics();
  });

  it("aggregates latency and outcomes by channel and RPC method", () => {
    observeBridgeRpcMethod({
      channel: "rest",
      method: "sql.execute",
      outcome: "success",
      elapsedMs: 10,
    });
    observeBridgeRpcMethod({
      channel: "rest",
      method: "sql.execute",
      outcome: "success",
      elapsedMs: 30,
    });
    observeBridgeRpcMethod({
      channel: "consumer_socket",
      method: "sql.bulkInsert",
      outcome: "error",
      elapsedMs: 50,
    });

    expect(getBridgeRpcMethodMetricsSnapshot()).toEqual([
      expect.objectContaining({
        channel: "consumer_socket",
        method: "sql.bulkInsert",
        outcome: "error",
        count: 1,
        latencyAvgMs: 50,
        latencyMaxMs: 50,
        latencyP95Ms: 50,
        latencyP99Ms: 50,
        latencySumMs: 50,
        latencyBuckets: expect.arrayContaining([
          { le: "25", count: 0 },
          { le: "50", count: 1 },
          { le: "+Inf", count: 1 },
        ]),
      }),
      expect.objectContaining({
        channel: "rest",
        method: "sql.execute",
        outcome: "success",
        count: 2,
        latencyAvgMs: 20,
        latencyMaxMs: 30,
        latencyP95Ms: 30,
        latencyP99Ms: 30,
        latencySumMs: 40,
        latencyBuckets: expect.arrayContaining([
          { le: "10", count: 1 },
          { le: "25", count: 1 },
          { le: "50", count: 2 },
          { le: "+Inf", count: 2 },
        ]),
      }),
    ]);
  });
});
