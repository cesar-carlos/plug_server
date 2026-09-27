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
  refundAgentRegisterRateLimitAsync: vi.fn(),
}));

vi.mock("../../../../../src/application/services/agent_hub_presence_sync", () => ({
  syncAgentHubPresenceOnRegister: vi.fn(async () => undefined),
  runAgentHubPresenceSyncSafely: vi.fn((input: { sync: () => Promise<void> }) => {
    void input.sync().catch(() => undefined);
  }),
}));

import { syncAgentHubPresenceOnRegister } from "../../../../../src/application/services/agent_hub_presence_sync";
import { handleAgentRegister } from "../../../../../src/presentation/socket/hub/handlers/agent_register.handler";
import type { AgentHubSocket } from "../../../../../src/presentation/socket/hub/handlers/_shared";
import { tryConsumeAgentRegisterRateLimitAsync } from "../../../../../src/presentation/socket/hub/rate_limits/agent_register_rate_limit";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { container } from "../../../../../src/shared/di/container";
import { env } from "../../../../../src/shared/config/env";
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
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.agentCapabilities, expect.anything());
    expect(scheduleAgentProfileSync).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      userId: USER_ID,
    });
  });

  it("should not increment parallelBatchDispatchNegotiatedTotal when extension is omitted", async () => {
    const socket = createAgentSocket();

    await handleAgentRegister(socket, buildRegisterFrame(baseCapabilities), {
      agentsNsp: createAgentsNamespace(SOCKET_ID),
      scheduleAgentProfileSync: vi.fn(),
    });

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

  it("coalesces two identical concurrent agent:register calls into one bind", async () => {
    let releaseBind!: () => void;
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    mockedBindOwnership.mockImplementation(async () => {
      await bindGate;
      return ok(undefined);
    });
    const socket = createAgentSocket();
    const ctx = {
      agentsNsp: createAgentsNamespace(SOCKET_ID),
      scheduleAgentProfileSync: vi.fn(),
    };
    const frame = buildRegisterFrame(baseCapabilities);
    const first = handleAgentRegister(socket, frame, ctx);
    const second = handleAgentRegister(socket, frame, ctx);
    releaseBind();
    await Promise.all([first, second]);
    expect(mockedBindOwnership).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.agentCapabilities, expect.anything());
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it("rejects a second agent:register with a different agentId on the same socket", async () => {
    const socket = createAgentSocket();
    const ctx = {
      agentsNsp: createAgentsNamespace(SOCKET_ID),
      scheduleAgentProfileSync: vi.fn(),
    };
    await handleAgentRegister(socket, buildRegisterFrame(baseCapabilities), ctx);
    await handleAgentRegister(
      socket,
      encodePayloadFrame(
        {
          agentId: "agent-register-handler-2",
          capabilities: baseCapabilities,
        },
        { requestId: "register-req-2" },
      ),
      ctx,
    );
    expect(mockedBindOwnership).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.agentRegisterError,
      expect.objectContaining({ reason: "invalid_request" }),
    );
  });

  it("discards bind work when the socket disconnects during ownership bind", async () => {
    const socket = createAgentSocket();
    mockedBindOwnership.mockImplementation(async () => {
      const { markAgentRegisterSocketDisconnected } =
        await import("../../../../../src/presentation/socket/hub/handshake/agent_register_handshake_state");
      markAgentRegisterSocketDisconnected(socket);
      return ok(undefined);
    });
    await handleAgentRegister(socket, buildRegisterFrame(baseCapabilities), {
      agentsNsp: createAgentsNamespace(SOCKET_ID),
      scheduleAgentProfileSync: vi.fn(),
    });
    expect(mockedPresenceSync).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith(socketEvents.agentCapabilities, expect.anything());
  });

  it("allows retry after a transient ownership bind failure", async () => {
    const socket = createAgentSocket();
    const ctx = {
      agentsNsp: createAgentsNamespace(SOCKET_ID),
      scheduleAgentProfileSync: vi.fn(),
    };
    mockedBindOwnership.mockRejectedValueOnce(new Error("db unavailable"));
    await handleAgentRegister(socket, buildRegisterFrame(baseCapabilities), ctx);
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.agentRegisterError,
      expect.objectContaining({ reason: "transient_failure" }),
    );
    mockedBindOwnership.mockResolvedValue(ok(undefined));
    await handleAgentRegister(socket, buildRegisterFrame(baseCapabilities), ctx);
    expect(mockedBindOwnership).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.agentCapabilities, expect.anything());
  });

  it("takeover disconnects the previous socket for the same agentId", async () => {
    const policySpy = vi
      .spyOn(env, "socketAgentSessionPolicy", "get")
      .mockReturnValue("takeover_disconnect_previous");
    const previousDisconnect = vi.fn();
    const previousEmit = vi.fn();
    const previous = {
      id: "socket-previous",
      data: { user: { sub: USER_ID } },
      emit: previousEmit,
      disconnect: previousDisconnect,
    } as unknown as AgentHubSocket & { emit: ReturnType<typeof vi.fn> };
    const next = createAgentSocket();
    const sockets = new Map<string, AgentHubSocket>([
      [previous.id, previous],
      [next.id, next],
    ]);
    const agentsNsp = {
      sockets: {
        has: (id: string) => sockets.has(id),
        get: (id: string) => sockets.get(id),
      },
    } as unknown as Namespace;
    await handleAgentRegister(previous, buildRegisterFrame(baseCapabilities), {
      agentsNsp,
      scheduleAgentProfileSync: vi.fn(),
    });
    await handleAgentRegister(next, buildRegisterFrame(baseCapabilities), {
      agentsNsp,
      scheduleAgentProfileSync: vi.fn(),
    });
    expect(previousEmit).toHaveBeenCalledWith(
      socketEvents.agentSessionSuperseded,
      expect.objectContaining({ reason: "session_superseded" }),
    );
    expect(previousDisconnect).toHaveBeenCalledWith(true);
    policySpy.mockRestore();
  });

  it("rejects a capabilities change after the socket is registered", async () => {
    const socket = createAgentSocket();
    const ctx = {
      agentsNsp: createAgentsNamespace(SOCKET_ID),
      scheduleAgentProfileSync: vi.fn(),
    };
    await handleAgentRegister(socket, buildRegisterFrame(baseCapabilities), ctx);
    await handleAgentRegister(
      socket,
      encodePayloadFrame(
        {
          agentId: AGENT_ID,
          capabilities: { ...baseCapabilities, compressions: ["none", "gzip"] },
        },
        { requestId: "register-req-caps" },
      ),
      ctx,
    );
    expect(mockedBindOwnership).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.agentRegisterError,
      expect.objectContaining({ reason: "invalid_request" }),
    );
  });
});
