import { afterEach, describe, expect, it, vi } from "vitest";

import {
  countOpenStreamRoutesForAgent,
  countStreamRoutesForAgent,
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteByStreamId,
  getActiveStreamRouteCount,
  removeActiveStreamRoute,
  resolveActiveStreamRoute,
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
    expect(countStreamRoutesForAgent("a1")).toBe(1);
    expect(countOpenStreamRoutesForAgent("a1")).toBe(1);
  });

  it("upsertActiveStreamRoute drops the previous stream id index when stream id changes", () => {
    upsertActiveStreamRoute({
      requestId: "r-rekey",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "s-old",
    });

    upsertActiveStreamRoute({
      requestId: "r-rekey",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "s-new",
    });

    expect(getActiveStreamRouteByStreamId("s-old")).toBeUndefined();
    expect(getActiveStreamRouteByStreamId("s-new")?.requestId).toBe("r-rekey");
  });

  it("rejects upsert collisions for the same request id from another agent socket", () => {
    upsertActiveStreamRoute({
      requestId: "r-collision",
      agentSocketId: "a1",
      streamHandlers: handlers,
    });

    expect(() =>
      upsertActiveStreamRoute({
        requestId: "r-collision",
        agentSocketId: "a2",
        streamHandlers: handlers,
      }),
    ).toThrow(/agent socket mismatch/i);
  });

  it("rejects stream id reuse by a different request id", () => {
    upsertActiveStreamRoute({
      requestId: "r-original",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "stream-shared",
    });

    expect(() =>
      upsertActiveStreamRoute({
        requestId: "r-other",
        agentSocketId: "a1",
        streamHandlers: handlers,
        streamId: "stream-shared",
      }),
    ).toThrow(/stream id is already registered/i);

    expect(getActiveStreamRouteByStreamId("stream-shared")?.requestId).toBe("r-original");
  });

  it("does not resolve ambiguous stream/request id pairs", () => {
    upsertActiveStreamRoute({
      requestId: "r-stream",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "s-shared",
    });
    upsertActiveStreamRoute({
      requestId: "r-other",
      agentSocketId: "a1",
      streamHandlers: handlers,
    });

    expect(
      resolveActiveStreamRoute("a1", {
        stream_id: "s-shared",
        request_id: "r-other",
      }),
    ).toBeNull();
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

  it("removeActiveStreamRoute rejects pending REST materialization once", () => {
    const reject = vi.fn();
    const timeoutHandle = setTimeout(() => {
      /* should be cleared */
    }, 60_000);
    const restMaterializeState = {
      settled: false,
      timeoutHandle,
      reject,
      agentId: "agent-1",
    };
    const route = upsertActiveStreamRoute({
      requestId: "r-rest",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "s-rest",
      restMaterializeState,
    });
    removeActiveStreamRoute(route);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(String(reject.mock.calls[0]?.[0]?.message ?? "")).toContain("SQL stream");

    removeActiveStreamRoute(route);
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it("removeActiveStreamRoute does not reject when REST materialization already settled", () => {
    const reject = vi.fn();
    const timeoutHandle = setTimeout(() => {}, 60_000);
    const restMaterializeState = {
      settled: true,
      timeoutHandle,
      reject,
      agentId: "agent-1",
    };
    const route = upsertActiveStreamRoute({
      requestId: "r-rest2",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "s-rest2",
      restMaterializeState,
    });
    removeActiveStreamRoute(route);
    expect(reject).not.toHaveBeenCalled();
  });

  it("removeActiveStreamRoute with restMaterialize detach clears timeout without rejecting", () => {
    const reject = vi.fn();
    let fired = false;
    const timeoutHandle = setTimeout(() => {
      fired = true;
    }, 60_000);
    const restMaterializeState = {
      settled: false,
      timeoutHandle,
      reject,
      agentId: "agent-1",
    };
    const route = upsertActiveStreamRoute({
      requestId: "r-detach",
      agentSocketId: "a1",
      streamHandlers: handlers,
      streamId: "s-detach",
      restMaterializeState,
    });
    removeActiveStreamRoute(route, { restMaterialize: "detach" });
    expect(reject).not.toHaveBeenCalled();
    expect(restMaterializeState.settled).toBe(true);
    expect(getActiveStreamRouteCount()).toBe(0);
    expect(fired).toBe(false);
  });
});
