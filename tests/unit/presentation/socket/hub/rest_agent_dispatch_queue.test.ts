import { afterEach, describe, expect, it } from "vitest";

import {
  acquireRestAgentDispatchSlot,
  getRestAgentDispatchQueueMetricsSnapshot,
  resetRestAgentDispatchQueue,
  wireRestAgentDispatchQueueMetrics,
} from "../../../../../src/presentation/socket/hub/rest_agent_dispatch_queue";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";

describe("rest_agent_dispatch_queue", () => {
  afterEach(() => {
    resetRestAgentDispatchQueue(serviceUnavailable("test reset"));
    wireRestAgentDispatchQueueMetrics(() => {});
  });

  it("getRestAgentDispatchQueueMetricsSnapshot reflects inflight after acquire", async () => {
    wireRestAgentDispatchQueueMetrics(() => {});
    const release = await acquireRestAgentDispatchSlot("agent-a");
    const snap = getRestAgentDispatchQueueMetricsSnapshot();
    expect(snap.totalInflight).toBe(1);
    expect(snap.totalQueuedWaiters).toBe(0);
    expect(snap.agentsWithQueuedWaiters).toBe(0);
    expect(snap.maxQueueDepthPerAgent).toBe(0);
    release();
    const after = getRestAgentDispatchQueueMetricsSnapshot();
    expect(after.totalInflight).toBe(0);
  });
});
