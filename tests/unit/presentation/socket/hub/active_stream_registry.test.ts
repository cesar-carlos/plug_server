import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteCount,
  removeActiveStreamRoute,
  resetActiveStreamRegistry,
  upsertActiveStreamRoute,
} from "../../../../../src/presentation/socket/hub/active_stream_registry";

afterEach(() => {
  resetActiveStreamRegistry();
});

const handlers = {
  consumerSocketId: "c1",
  onChunk: vi.fn(),
  onComplete: vi.fn(),
};

describe("active_stream_registry", () => {
  it("upsertActiveStreamRoute registers by request id and updates stream id", () => {
    upsertActiveStreamRoute({
      requestId: "r1",
      agentSocketId: "a1",
      streamHandlers: handlers,
    });
    expect(getActiveStreamRouteCount()).toBe(1);

    upsertActiveStreamRoute({
      requestId: "r1",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "s1",
    });
    const route = getActiveStreamRouteByRequestId("r1");
    expect(route?.streamId).toBe("s1");
  });

  it("removeActiveStreamRoute drops the route", () => {
    const route = upsertActiveStreamRoute({
      requestId: "r2",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "s2",
    });
    removeActiveStreamRoute(route);
    expect(getActiveStreamRouteCount()).toBe(0);
  });
});
