import type * as EnvModule from "../../../../../src/shared/config/env";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      socketRestAgentMaxInflight: 32,
      socketRestAgentMaxQueue: 64,
      socketRestAgentQueueWaitMs: 200,
    },
  };
});

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
