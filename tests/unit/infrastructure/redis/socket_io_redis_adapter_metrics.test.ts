import { afterEach, describe, expect, it } from "vitest";

import {
  getSocketIoRedisAdapterMetricsSnapshot,
  noteSocketIoRedisAdapterConnected,
  noteSocketIoRedisAdapterDisconnected,
  noteSocketIoRedisAdapterRuntimeError,
  resetSocketIoRedisAdapterMetricsForTests,
} from "../../../../src/application/services/socket_io_redis_adapter_metrics.service";

describe("socket_io_redis_adapter_metrics", () => {
  afterEach(() => {
    resetSocketIoRedisAdapterMetricsForTests();
  });

  it("counts runtime errors without incrementing fallback events", () => {
    noteSocketIoRedisAdapterConnected();
    noteSocketIoRedisAdapterRuntimeError();

    const snapshot = getSocketIoRedisAdapterMetricsSnapshot();
    expect(snapshot.runtimeErrorEventsTotal).toBe(1);
    expect(snapshot.fallbackEventsTotal).toBe(0);
    expect(snapshot.redisAdapterActive).toBe(0);
  });

  it("marks the adapter inactive on disconnect", () => {
    noteSocketIoRedisAdapterConnected();
    noteSocketIoRedisAdapterDisconnected();

    const snapshot = getSocketIoRedisAdapterMetricsSnapshot();
    expect(snapshot.redisAdapterActive).toBe(0);
    expect(snapshot.redisUrlConfigured).toBe(1);
  });
});
