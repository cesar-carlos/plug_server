import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingRequest } from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import {
  clearRestPendingRequest,
  forEachUniqueRestPendingRequest,
  getRestPendingRequestCount,
  hasRestPendingCorrelationId,
  registerRestPendingRequest,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetRpcBridgeMutableStores } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_lifecycle";

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

  it("rejects correlation id collisions without changing the logical count", () => {
    const first = basePending();
    const second = {
      ...basePending(),
      primaryRequestId: "p2",
      correlationIds: ["b", "c"],
    };
    registerRestPendingRequest(first);

    expect(() => registerRestPendingRequest(second)).toThrow(/already registered/i);
    expect(getRestPendingRequestCount()).toBe(1);
    expect(hasRestPendingCorrelationId("a")).toBe(true);
    expect(hasRestPendingCorrelationId("b")).toBe(true);
    expect(hasRestPendingCorrelationId("c")).toBe(false);
  });

  it("registering the same pending twice is idempotent for logical count", () => {
    const p = basePending();
    registerRestPendingRequest(p);
    registerRestPendingRequest(p);

    expect(getRestPendingRequestCount()).toBe(1);
  });

  it("bridge reset rejects pending requests before clearing the store", () => {
    const p = basePending();
    registerRestPendingRequest(p);

    resetRpcBridgeMutableStores();

    expect(p.reject).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(p.reject).mock.calls[0]?.[0]?.message ?? "")).toContain(
      "Socket bridge has been reset",
    );
    expect(getRestPendingRequestCount()).toBe(0);
  });
});
