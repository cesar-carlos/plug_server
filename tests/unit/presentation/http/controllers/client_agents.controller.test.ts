import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Response } from "express";

import { Agent } from "../../../../../src/domain/entities/agent.entity";
import { ok } from "../../../../../src/shared/errors/result";
import {
  getMyClientAgent,
  listMyClientAgents,
} from "../../../../../src/presentation/http/controllers/client_agents.controller";

const mockListApprovedAgentsPage = vi.fn();
const mockFindApprovedAgent = vi.fn();
const mockHasClientTokenForAgent = vi.fn();
const mockIsAgentConnected = vi.fn();
const mockGetConnectedAgentIdSet = vi.fn();

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    clientAgentAccessQueryService: {
      listApprovedAgentsPage: (...args: unknown[]) => mockListApprovedAgentsPage(...args),
      findApprovedAgent: (...args: unknown[]) => mockFindApprovedAgent(...args),
      hasClientTokenForAgent: (...args: unknown[]) => mockHasClientTokenForAgent(...args),
    },
    restAgentBridgeService: {
      isAgentConnected: (...args: unknown[]) => mockIsAgentConnected(...args),
      getConnectedAgentIdSet: (...args: unknown[]) => mockGetConnectedAgentIdSet(...args),
    },
  },
}));

vi.mock("../../../../../src/shared/metrics/client_me_agents.metrics", () => ({
  recordClientMeAgentsListResponse: vi.fn(),
  recordClientMeAgentsDetailResponse: vi.fn(),
}));

const sampleAgent = new Agent({
  agentId: "agent-a",
  name: "Agent A",
  tradeName: undefined,
  document: undefined,
  documentType: undefined,
  phone: undefined,
  mobile: undefined,
  email: undefined,
  street: undefined,
  number: undefined,
  district: undefined,
  postalCode: undefined,
  city: undefined,
  state: undefined,
  notes: undefined,
  profileUpdatedAt: undefined,
  profileVersion: 1,
  lastLoginUserId: undefined,
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

describe("client_agents.controller", () => {
  beforeEach(() => {
    mockListApprovedAgentsPage.mockReset();
    mockFindApprovedAgent.mockReset();
    mockHasClientTokenForAgent.mockReset();
    mockIsAgentConnected.mockReset();
    mockGetConnectedAgentIdSet.mockReset();
  });

  describe("listMyClientAgents", () => {
    it("should map isHubConnected via restAgentBridgeService", async () => {
      mockListApprovedAgentsPage.mockResolvedValue({
        items: [{ agent: sampleAgent, hasClientToken: true }],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      mockIsAgentConnected.mockReturnValue(true);
      mockGetConnectedAgentIdSet.mockReturnValue(new Set(["agent-a"]));

      const response = {
        locals: {
          authClient: { sub: "client-1" },
          validated: { query: {} },
        },
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;

      await listMyClientAgents({} as never, response);

      expect(mockGetConnectedAgentIdSet).toHaveBeenCalledOnce();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: [expect.objectContaining({ agentId: "agent-a", isHubConnected: true })],
        }),
      );
    });
  });

  describe("getMyClientAgent", () => {
    it("should map isHubConnected via restAgentBridgeService", async () => {
      mockFindApprovedAgent.mockResolvedValue(ok(sampleAgent));
      mockIsAgentConnected.mockReturnValue(false);
      mockHasClientTokenForAgent.mockResolvedValue(false);

      const response = {
        locals: {
          authClient: { sub: "client-1" },
          validated: { params: { agentId: "agent-a" } },
        },
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      await getMyClientAgent({} as never, response, next);

      expect(mockIsAgentConnected).toHaveBeenCalledWith("agent-a");
      expect(response.json).toHaveBeenCalledWith({
        agent: expect.objectContaining({ agentId: "agent-a", isHubConnected: false }),
      });
    });
  });
});
