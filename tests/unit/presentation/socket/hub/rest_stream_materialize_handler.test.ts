import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { resetActiveStreamRegistry } from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import type { PendingRequest } from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import { startRestStreamMaterialization } from "../../../../../src/presentation/socket/hub/relay/rest_stream_materialize_handler";

const pendingRequest = (agentId: string): PendingRequest => ({
  primaryRequestId: `req-${agentId}`,
  correlationIds: [`req-${agentId}`],
  socketId: "socket-1",
  agentId,
  createdAtMs: Date.now(),
  resolve: () => undefined,
  reject: () => undefined,
  timeoutHandle: setTimeout(() => undefined, 60_000),
  acked: true,
});

const registerAgent = (agentId: string, maxStreamPullWindowSize: number): void => {
  agentRegistry.upsert({
    agentId,
    socketId: "socket-1",
    userId: null,
    capabilities: {
      extensions: {
        recommendedStreamPullWindowSize: 12,
        maxStreamPullWindowSize,
      },
    },
  });
};

describe("startRestStreamMaterialization pull window", () => {
  const requests: PendingRequest[] = [];

  afterEach(() => {
    for (const request of requests) clearTimeout(request.timeoutHandle);
    requests.length = 0;
    resetActiveStreamRegistry();
    agentRegistry.clear();
  });

  const start = (agentId: string): ReturnType<typeof vi.fn> => {
    const request = pendingRequest(agentId);
    requests.push(request);
    const emitPull = vi.fn();
    startRestStreamMaterialization({
      socketId: "socket-1",
      pendingRequest: request,
      decoded: { data: { result: { rows: [] } }, frame: { originalSize: 2 } },
      streamId: `stream-${agentId}`,
      emitRpcStreamPullForRoute: emitPull,
    });
    return emitPull;
  };

  it("should pull the configured REST window when the agent recommends a smaller window", () => {
    registerAgent("agent-wide", 1000);
    const emitPull = start("agent-wide");

    expect(emitPull).toHaveBeenCalledTimes(1);
    expect(emitPull.mock.calls[0]?.[1]).toBe(env.socketRestStreamPullWindowSize);
  });

  it("should clamp the REST pull window to the agent maximum", () => {
    registerAgent("agent-small", 7);
    const emitPull = start("agent-small");

    expect(emitPull).toHaveBeenCalledTimes(1);
    expect(emitPull.mock.calls[0]?.[1]).toBe(7);
  });
});
