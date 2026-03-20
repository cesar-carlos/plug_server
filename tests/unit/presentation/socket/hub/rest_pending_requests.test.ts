import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingRequest } from "../../../../../src/presentation/socket/hub/rest_pending_requests";
import {
  clearRestPendingRequest,
  forEachUniqueRestPendingRequest,
  getRestPendingRequestCount,
  hasRestPendingCorrelationId,
  registerRestPendingRequest,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/rest_pending_requests";

afterEach(() => {
  resetRestPendingRequestsStore();
});

const basePending = (): PendingRequest => ({
  primaryRequestId: "p1",
  correlationIds: ["a", "b"],
  socketId: "sock",
  agentId: "agent",
  createdAtMs: 0,
  resolve: vi.fn(),
  reject: vi.fn(),
  timeoutHandle: {} as NodeJS.Timeout,
  acked: false,
});

describe("rest_pending_requests store", () => {
  it("registers multiple correlation ids for one logical pending and counts once", () => {
    const p = basePending();
    registerRestPendingRequest(p);
    expect(getRestPendingRequestCount()).toBe(1);
    expect(hasRestPendingCorrelationId("a")).toBe(true);
    expect(hasRestPendingCorrelationId("b")).toBe(true);
  });

  it("clears all correlation entries and decrements logical count", () => {
    const p = basePending();
    registerRestPendingRequest(p);
    clearRestPendingRequest(p);
    expect(getRestPendingRequestCount()).toBe(0);
    expect(hasRestPendingCorrelationId("a")).toBe(false);
  });

  it("forEachUniqueRestPendingRequest visits each logical pending once when map aliases", () => {
    const p = basePending();
    registerRestPendingRequest(p);
    const seen: PendingRequest[] = [];
    forEachUniqueRestPendingRequest((x) => {
      seen.push(x);
    });
    expect(seen).toEqual([p]);
  });
});
