import { afterEach, describe, expect, it, vi } from "vitest";

import type { RelayRequestRoute } from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import {
  findRelayRequestRouteForAgentSocket,
  getRelayPendingRequestCountForConversation,
  getRelayRegisteredRouteCount,
  listRelayRequestIdsForConsumer,
  registerRelayRequestRoute,
  removeRelayRequestRoute,
  reserveRelayPendingSlot,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import {
  relayStreamFlowState,
  resetRelayStreamFlowState,
} from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";

afterEach(() => {
  resetRelayRequestRegistry();
  resetRelayStreamFlowState();
});

const fakeTimeout = {} as NodeJS.Timeout;

const makeRoute = (
  overrides: Partial<RelayRequestRoute> & Pick<RelayRequestRoute, "requestId">,
): RelayRequestRoute => ({
  conversationId: "conv",
  consumerSocketId: "cons",
  agentSocketId: "agentSock",
  agentId: "agent",
  timeoutHandle: fakeTimeout,
  createdAtMs: 0,
  ...overrides,
});

describe("relay_request_registry", () => {
  it("register and remove update pending counts and indexes", () => {
    const r = makeRoute({ requestId: "r1" });
    registerRelayRequestRoute(r);
    expect(getRelayRegisteredRouteCount()).toBe(1);
    expect(getRelayPendingRequestCountForConversation("conv")).toBe(1);
    expect(listRelayRequestIdsForConsumer("cons")).toEqual(["r1"]);

    removeRelayRequestRoute("r1");
    expect(getRelayRegisteredRouteCount()).toBe(0);
    expect(getRelayPendingRequestCountForConversation("conv")).toBe(0);
    expect(listRelayRequestIdsForConsumer("cons")).toEqual([]);
  });

  it("findRelayRequestRouteForAgentSocket matches agent socket", () => {
    registerRelayRequestRoute(makeRoute({ requestId: "a", agentSocketId: "sock1" }));
    registerRelayRequestRoute(makeRoute({ requestId: "b", agentSocketId: "sock2" }));

    expect(findRelayRequestRouteForAgentSocket(["x", "b"], "sock2")?.requestId).toBe("b");
    expect(findRelayRequestRouteForAgentSocket(["a"], "sock2")).toBeUndefined();
  });

  it("replacing an existing request id keeps pending counters consistent", () => {
    registerRelayRequestRoute(makeRoute({ requestId: "same", conversationId: "conv-a" }));
    registerRelayRequestRoute(
      makeRoute({ requestId: "same", conversationId: "conv-b", consumerSocketId: "cons-b" }),
    );

    expect(getRelayRegisteredRouteCount()).toBe(1);
    expect(getRelayPendingRequestCountForConversation("conv-a")).toBe(0);
    expect(getRelayPendingRequestCountForConversation("conv-b")).toBe(1);
    expect(listRelayRequestIdsForConsumer("cons")).toEqual([]);
    expect(listRelayRequestIdsForConsumer("cons-b")).toEqual(["same"]);
  });

  it("removeRelayRequestRoute clears stream flow state for unknown route id", () => {
    relayStreamFlowState.creditsByRequestId.set("orphan", 1);
    removeRelayRequestRoute("orphan");
    expect(relayStreamFlowState.creditsByRequestId.has("orphan")).toBe(false);
  });

  it("resetRelayRequestRegistry clears stream flow state for registered routes", () => {
    registerRelayRequestRoute(makeRoute({ requestId: "with-flow" }));
    relayStreamFlowState.creditsByRequestId.set("with-flow", 1);

    resetRelayRequestRegistry();

    expect(relayStreamFlowState.creditsByRequestId.has("with-flow")).toBe(false);
  });

  it("releases agent dispatch slots when routes are removed or reset", () => {
    const releaseRemoved = vi.fn();
    registerRelayRequestRoute(
      makeRoute({ requestId: "release-me", releaseAgentDispatchSlot: releaseRemoved }),
    );

    removeRelayRequestRoute("release-me");
    removeRelayRequestRoute("release-me");

    expect(releaseRemoved).toHaveBeenCalledTimes(1);

    const releaseReset = vi.fn();
    registerRelayRequestRoute(
      makeRoute({ requestId: "reset-me", releaseAgentDispatchSlot: releaseReset }),
    );
    resetRelayRequestRegistry();

    expect(releaseReset).toHaveBeenCalledTimes(1);
  });

  it("reserveRelayPendingSlot transfers counters to register without double counting", () => {
    const reservation = reserveRelayPendingSlot("conv", "cons");
    expect(reservation).not.toBeNull();
    expect(getRelayPendingRequestCountForConversation("conv")).toBe(1);

    registerRelayRequestRoute(makeRoute({ requestId: "reserved", conversationId: "conv" }), {
      countersReserved: true,
    });
    expect(getRelayRegisteredRouteCount()).toBe(1);
    expect(getRelayPendingRequestCountForConversation("conv")).toBe(1);
  });
});
