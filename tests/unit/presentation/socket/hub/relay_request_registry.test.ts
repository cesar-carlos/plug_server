import { afterEach, describe, expect, it } from "vitest";

import type { RelayRequestRoute } from "../../../../../src/presentation/socket/hub/relay_request_registry";
import {
  findRelayRequestRouteForAgentSocket,
  getRelayPendingRequestCountForConversation,
  getRelayRegisteredRouteCount,
  listRelayRequestIdsForConsumer,
  registerRelayRequestRoute,
  removeRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/relay_request_registry";
import {
  relayStreamFlowState,
  resetRelayStreamFlowState,
} from "../../../../../src/presentation/socket/hub/relay_stream_flow_state";

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

  it("removeRelayRequestRoute clears stream flow state for unknown route id", () => {
    relayStreamFlowState.creditsByRequestId.set("orphan", 1);
    removeRelayRequestRoute("orphan");
    expect(relayStreamFlowState.creditsByRequestId.has("orphan")).toBe(false);
  });
});
