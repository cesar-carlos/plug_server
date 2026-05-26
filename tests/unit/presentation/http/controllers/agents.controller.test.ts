import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Response } from "express";

import {
  listConnectedAgents,
  proxyCommandToAgent,
} from "../../../../../src/presentation/http/controllers/agents.controller";
import { executeAuthorizedAgentCommand } from "../../../../../src/application/agent_commands/execute_authorized_agent_command";
import { env } from "../../../../../src/shared/config/env";

const mockListConnectedAgents = vi.fn();
const mockGetAgentsNamespaceConnectionCount = vi.fn();
const mockGetDispatchCommand = vi.fn();
const mockListAgentIdsByUserId = vi.fn();

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    restAgentBridgeService: {
      listConnectedAgents: (...args: unknown[]) => mockListConnectedAgents(...args),
      getAgentsNamespaceConnectionCount: (...args: unknown[]) =>
        mockGetAgentsNamespaceConnectionCount(...args),
      getDispatchCommand: (...args: unknown[]) => mockGetDispatchCommand(...args),
    },
    userAgentService: {
      listAgentIdsByUserId: (...args: unknown[]) => mockListAgentIdsByUserId(...args),
    },
    agentAccessService: {},
  },
}));

vi.mock("../../../../../src/application/agent_commands/execute_authorized_agent_command", () => ({
  executeAuthorizedAgentCommand: vi.fn(),
}));

const mockedExecuteAuthorizedAgentCommand = vi.mocked(executeAuthorizedAgentCommand);

describe("agents.controller", () => {
  beforeEach(() => {
    mockListConnectedAgents.mockReset();
    mockGetAgentsNamespaceConnectionCount.mockReset();
    mockGetDispatchCommand.mockReset();
    mockListAgentIdsByUserId.mockReset();
    mockedExecuteAuthorizedAgentCommand.mockReset();
    mockGetDispatchCommand.mockReturnValue(vi.fn());
  });

  describe("listConnectedAgents", () => {
    it("should return connected agents filtered by user visibility", async () => {
      mockListConnectedAgents.mockReturnValue([
        {
          agentId: "agent-a",
          userId: "user-1",
          capabilities: {},
          connectedAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:01.000Z",
        },
        {
          agentId: "agent-b",
          userId: "user-1",
          capabilities: {},
          connectedAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:01.000Z",
        },
      ]);
      mockListAgentIdsByUserId.mockResolvedValue(["agent-a"]);

      const request = { headers: {} } as unknown as Parameters<typeof listConnectedAgents>[0];
      const response = {
        locals: {
          authUser: { sub: "user-1", role: "user" },
          validated: { query: {} },
        },
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;

      await listConnectedAgents(request, response);

      expect(mockListConnectedAgents).toHaveBeenCalledOnce();
      expect(mockListAgentIdsByUserId).toHaveBeenCalledWith("user-1");
      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.json).toHaveBeenCalledWith({
        agents: [
          {
            agentId: "agent-a",
            userId: "user-1",
            capabilities: {},
            connectedAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:01.000Z",
          },
        ],
        count: 1,
      });
    });

    it("should include admin diagnostic socket count outside production", async () => {
      mockListConnectedAgents.mockReturnValue([]);
      mockGetAgentsNamespaceConnectionCount.mockReturnValue(3);

      const previousNodeEnv = env.nodeEnv;
      Object.defineProperty(env, "nodeEnv", { value: "development", configurable: true });

      const request = { headers: {} } as unknown as Parameters<typeof listConnectedAgents>[0];
      const response = {
        locals: {
          authUser: { sub: "admin-1", role: "admin" },
          validated: { query: {} },
        },
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;

      await listConnectedAgents(request, response);

      expect(mockGetAgentsNamespaceConnectionCount).toHaveBeenCalledOnce();
      expect(response.json).toHaveBeenCalledWith({
        agents: [],
        count: 0,
        _diagnostic: { socketConnectionsInAgentsNamespace: 3 },
      });

      Object.defineProperty(env, "nodeEnv", { value: previousNodeEnv, configurable: true });
    });
  });

  describe("proxyCommandToAgent", () => {
    it("should delegate dispatch to restAgentBridgeService", async () => {
      const dispatch = vi.fn();
      mockGetDispatchCommand.mockReturnValue(dispatch);
      mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
        requestId: "req-1",
        response: { ok: true },
      });

      const response = {
        locals: {
          authUser: { sub: "user-1", role: "user" },
          validated: {
            body: {
              agentId: "agent-a",
              command: { jsonrpc: "2.0", method: "ping", id: "1" },
            },
          },
        },
        writableEnded: false,
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;

      await proxyCommandToAgent({} as never, response, vi.fn());

      expect(mockGetDispatchCommand).toHaveBeenCalledOnce();
      expect(mockedExecuteAuthorizedAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-a",
        }),
        expect.anything(),
        dispatch,
        expect.any(Function),
      );
      expect(response.status).toHaveBeenCalledWith(200);
    });
  });
});
