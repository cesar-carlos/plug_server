import type * as EnvModule from "../../../../../../src/shared/config/env";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      socketRestAgentMaxInflight: 1,
      socketRelayAgentMaxInflight: 1,
      socketRestAgentMaxQueue: 64,
      socketRelayAgentMaxQueue: 64,
      socketRestAgentQueueWaitMs: 200,
      socketRelayAgentQueueWaitMs: 200,
    },
  };
});

import { agentRegistry } from "../../../../../../src/presentation/socket/hub/registries/agent_registry";
import { acquireRelayAgentDispatchSlot } from "../../../../../../src/presentation/socket/hub/relay/relay_agent_dispatch_queue";
import {
  acquireRestAgentDispatchSlot,
  resetRestAgentDispatchQueue,
} from "../../../../../../src/presentation/socket/hub/relay/rest_agent_dispatch_queue";
import { shouldSkipAgentHealthPollDueToDispatchSaturation } from "../../../../../../src/presentation/socket/hub/scheduling/agent_dispatch_saturation";
import { serviceUnavailable } from "../../../../../../src/shared/errors/http_errors";
import { resetRelayAgentDispatchQueue } from "../../../../../../src/presentation/socket/hub/relay/relay_agent_dispatch_queue";

describe("agent_dispatch_saturation", () => {
  afterEach(() => {
    const resetError = serviceUnavailable("test reset");
    resetRestAgentDispatchQueue(resetError);
    resetRelayAgentDispatchQueue(resetError);
    agentRegistry.clear();
  });

  it("returns false when no inflight or queued waiters", () => {
    const result = agentRegistry.registerAgentSession({
      agentId: "agent-open",
      socketId: "socket-open",
      userId: "user-1",
      capabilities: {},
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    expect(result.ok).toBe(true);

    expect(shouldSkipAgentHealthPollDueToDispatchSaturation("agent-open")).toBe(false);
  });

  it("returns true when REST dispatch inflight is at capacity", async () => {
    const result = agentRegistry.registerAgentSession({
      agentId: "agent-rest-saturated",
      socketId: "socket-rest-saturated",
      userId: "user-1",
      capabilities: {},
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    expect(result.ok).toBe(true);

    const release = await acquireRestAgentDispatchSlot("agent-rest-saturated");
    expect(shouldSkipAgentHealthPollDueToDispatchSaturation("agent-rest-saturated")).toBe(true);
    release();
    expect(shouldSkipAgentHealthPollDueToDispatchSaturation("agent-rest-saturated")).toBe(false);
  });

  it("returns true when relay dispatch has queued waiters", async () => {
    const result = agentRegistry.registerAgentSession({
      agentId: "agent-relay-queued",
      socketId: "socket-relay-queued",
      userId: "user-1",
      capabilities: {},
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    expect(result.ok).toBe(true);

    const release = await acquireRelayAgentDispatchSlot("agent-relay-queued");
    const waiter = acquireRelayAgentDispatchSlot("agent-relay-queued");
    await vi.waitFor(() =>
      expect(shouldSkipAgentHealthPollDueToDispatchSaturation("agent-relay-queued")).toBe(true),
    );
    release();
    await waiter.then((releaseWaiter) => releaseWaiter());
    expect(shouldSkipAgentHealthPollDueToDispatchSaturation("agent-relay-queued")).toBe(false);
  });
});
