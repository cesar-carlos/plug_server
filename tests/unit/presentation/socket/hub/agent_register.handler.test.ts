import type { Namespace } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUB_TRANSPORT_EXTENSIONS } from "../../../../../src/shared/constants/agent_transport_contract";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { ok } from "../../../../../src/shared/errors/result";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    agentAccessService: {
      bindOwnershipOnRegister: vi.fn(),
    },
  },
}));

vi.mock("../../../../../src/presentation/socket/hub/rate_limits/agent_register_rate_limit", () => ({
  tryConsumeAgentRegisterRateLimitAsync: vi.fn(),
}));

vi.mock("../../../../../src/application/services/agent_hub_presence_sync", () => ({
  syncAgentHubPresenceOnRegister: vi.fn(),
}));

import { syncAgentHubPresenceOnRegister } from "../../../../../src/application/services/agent_hub_presence_sync";
import { handleAgentRegister } from "../../../../../src/presentation/socket/hub/handlers/agent_register.handler";
import type { AgentHubSocket } from "../../../../../src/presentation/socket/hub/handlers/_shared";
import { tryConsumeAgentRegisterRateLimitAsync } from "../../../../../src/presentation/socket/hub/rate_limits/agent_register_rate_limit";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { container } from "../../../../../src/shared/di/container";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "../../../../../src/shared/metrics/socket_agent.metrics";

const AGENT_ID = "agent-register-handler-1";
const USER_ID = "user-register-handler-1";
const SOCKET_ID = "socket-register-handler-1";

const createAgentSocket = (): AgentHubSocket & { emit: ReturnType<typeof vi.fn> } => {
  const emit = vi.fn();
  return {
    id: SOCKET_ID,
    data: { user: { sub: USER_ID } },
    emit,
  } as unknown as AgentHubSocket & { emit: ReturnType<typeof vi.fn> };
};

const createAgentsNamespace = (socketId: string): Namespace =>
  ({
    sockets: {
      has: (id: string) => id === socketId,
      get: () => undefined,
    },
  }) as unknown as Namespace;

const buildRegisterFrame = (capabilities: Record<string, unknown>): unknown =>
  encodePayloadFrame(
    {
      agentId: AGENT_ID,
      capabilities,
    },
    { requestId: "register-req-1" },
  );

describe("handleAgentRegister parallelBatchDispatch adoption", () => {
  const mockedBindOwnership = vi.mocked(container.agentAccessService.bindOwnershipOnRegister);
  const mockedRateLimit = vi.mocked(tryConsumeAgentRegisterRateLimitAsync);
  const mockedPresenceSync = vi.mocked(syncAgentHubPresenceOnRegister);

  beforeEach(() => {
    resetSocketAgentMetrics();
    agentRegistry.clear();
    mockedBindOwnership.mockReset();
    mockedRateLimit.mockReset();
    mockedPresenceSync.mockReset();
    mockedBindOwnership.mockResolvedValue(ok(undefined));
    mockedRateLimit.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    resetSocketAgentMetrics();
    agentRegistry.clear();
    vi.clearAllMocks();
  });

  const baseCapabilities = {
    protocols: ["jsonrpc-v2"],
    encodings: ["json"],
    compressions: ["none"],
    extensions: {} as Record<string, unknown>,
    limits: {},
  };

  const negotiatedParallelBatchExtensions = {
    parallelBatchDispatch: {
      enabled: true,
      maxConcurrency: HUB_TRANSPORT_EXTENSIONS.parallelBatchDispatch.maxConcurrency,
      mixedReadOnlyMethods: true,
      selectOnlySqlExecute: true,
    },
  };

  it("should increment parallelBatchDispatchNegotiatedTotal when extension is negotiated on register", async () => {
    const socket = createAgentSocket();
    const scheduleAgentProfileSync = vi.fn();

    await handleAgentRegister(
      socket,
      buildRegisterFrame({
        ...baseCapabilities,
        extensions: negotiatedParallelBatchExtensions,
      }),
      {
        agentsNsp: createAgentsNamespace(SOCKET_ID),
        scheduleAgentProfileSync,
      },
    );

    expect(getSocketAgentMetricsSnapshot().parallelBatchDispatchNegotiatedTotal).toBe(1);
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.agentCapabilities,
      expect.anything(),
    );
    expect(scheduleAgentProfileSync).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      userId: USER_ID,
    });
  });

  it("should not increment parallelBatchDispatchNegotiatedTotal when extension is omitted", async () => {
    const socket = createAgentSocket();

    await handleAgentRegister(
      socket,
      buildRegisterFrame(baseCapabilities),
      {
        agentsNsp: createAgentsNamespace(SOCKET_ID),
        scheduleAgentProfileSync: vi.fn(),
      },
    );

    expect(getSocketAgentMetricsSnapshot().parallelBatchDispatchNegotiatedTotal).toBe(0);
  });

  it("should not increment parallelBatchDispatchNegotiatedTotal when parallel batch is disabled", async () => {
    const socket = createAgentSocket();

    await handleAgentRegister(
      socket,
      buildRegisterFrame({
        ...baseCapabilities,
        extensions: {
          parallelBatchDispatch: { enabled: false },
        },
      }),
      {
        agentsNsp: createAgentsNamespace(SOCKET_ID),
        scheduleAgentProfileSync: vi.fn(),
      },
    );

    expect(getSocketAgentMetricsSnapshot().parallelBatchDispatchNegotiatedTotal).toBe(0);
  });
});
