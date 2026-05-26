import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/config/env", () => ({
  env: {
    socketRestAgentMaxInflight: 0,
    socketRestAgentMaxQueue: 64,
    socketRestAgentQueueWaitMs: 200,
  },
}));

import {
  acquireRestAgentDispatchSlot,
  getRestAgentDispatchQueueMetricsSnapshot,
  resetRestAgentDispatchQueue,
} from "../../../../../src/presentation/socket/hub/relay/rest_agent_dispatch_queue";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";

describe("rest_agent_dispatch_queue (SOCKET_REST_AGENT_MAX_INFLIGHT=0)", () => {
  afterEach(() => {
    resetRestAgentDispatchQueue(serviceUnavailable("test reset"));
  });

  it("does not track inflight when unlimited", async () => {
    const a = await acquireRestAgentDispatchSlot("agent-unlimited");
    const b = await acquireRestAgentDispatchSlot("agent-unlimited");
    expect(getRestAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(0);
    a();
    b();
    expect(getRestAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(0);
  });
});
