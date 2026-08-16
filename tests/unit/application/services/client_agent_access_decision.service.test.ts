import { describe, expect, it, vi } from "vitest";

import { ClientAgentAccessDecisionService } from "../../../../src/application/services/client_agent_access_decision.service";
import { Agent } from "../../../../src/domain/entities/agent.entity";
import { Client } from "../../../../src/domain/entities/client.entity";
import { ClientAgentAccessRequest } from "../../../../src/domain/entities/client_agent_access_request.entity";
import { notFound } from "../../../../src/shared/errors/http_errors";

const ownerUserId = "owner-1";
const clientId = "client-1";
const agentId = "agent-1";
const requestId = "request-1";
const tokenId = "token-1";

const makeAgent = (): Agent => Agent.create({ agentId, name: "Agent One" });

const makeClient = (): Client =>
  Client.create({
    id: clientId,
    userId: ownerUserId,
    email: "client@test.com",
    passwordHash: "hash",
    name: "Ada",
    lastName: "Lovelace",
    status: "active",
  });

const makeRequest = (status: "pending" | "approved" = "pending"): ClientAgentAccessRequest =>
  ClientAgentAccessRequest.create({
    id: requestId,
    clientId,
    agentId,
    status,
  });

const makeService = (deps: {
  readonly agentRepository?: Record<string, ReturnType<typeof vi.fn>>;
  readonly identityRepository?: Record<string, ReturnType<typeof vi.fn>>;
  readonly clientRepository?: Record<string, ReturnType<typeof vi.fn>>;
  readonly accessRepository?: Record<string, ReturnType<typeof vi.fn>>;
  readonly requestRepository?: Record<string, ReturnType<typeof vi.fn>>;
  readonly tokenRepository?: Record<string, ReturnType<typeof vi.fn>>;
  readonly approvalTxn?: Record<string, ReturnType<typeof vi.fn>>;
}): ClientAgentAccessDecisionService =>
  new ClientAgentAccessDecisionService(
    { findById: vi.fn(), ...deps.agentRepository } as never,
    { findOwnerUserId: vi.fn(), ...deps.identityRepository } as never,
    {
      findById: vi.fn(),
      findByIds: vi.fn().mockResolvedValue([]),
      ...deps.clientRepository,
    } as never,
    {
      listByAgentId: vi.fn().mockResolvedValue([]),
      ...deps.accessRepository,
    } as never,
    { findById: vi.fn(), ...deps.requestRepository } as never,
    {
      findById: vi.fn(),
      findReviewSummaryById: vi.fn(),
      deleteById: vi.fn(),
      ...deps.tokenRepository,
    } as never,
    {
      sendClientAccessApproved: vi.fn(),
      sendClientAccessRejected: vi.fn(),
    } as never,
    {
      approvePendingAndGrantAccess: vi.fn().mockResolvedValue(true),
      rejectPendingAndConsumeToken: vi.fn().mockResolvedValue(true),
      ...deps.approvalTxn,
    } as never,
  );

describe("ClientAgentAccessDecisionService remaining branches", () => {
  it("returns a review summary from the projection including optional agent name", async () => {
    const service = makeService({
      tokenRepository: {
        findReviewSummaryById: vi.fn().mockResolvedValue({
          clientEmail: "client@test.com",
          clientName: "Ada Lovelace",
          agentId,
          agentName: "Agent One",
          requestStatus: "pending",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }),
      },
    });

    await expect(service.getReviewSummaryByToken(tokenId)).resolves.toEqual({
      clientEmail: "client@test.com",
      clientName: "Ada Lovelace",
      agentId,
      agentName: "Agent One",
      requestStatus: "pending",
      tokenStatus: "pending",
    });
  });

  it("returns null when the token exists but the access request is gone", async () => {
    const service = makeService({
      tokenRepository: {
        findReviewSummaryById: vi.fn().mockResolvedValue(null),
        findById: vi.fn().mockResolvedValue({
          id: tokenId,
          requestId,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          createdAt: new Date(),
        }),
      },
      requestRepository: { findById: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.getReviewSummaryByToken(tokenId)).resolves.toBeNull();
  });

  it("builds a fallback review summary when the client still exists", async () => {
    const service = makeService({
      tokenRepository: {
        findReviewSummaryById: vi.fn().mockResolvedValue(null),
        findById: vi.fn().mockResolvedValue({
          id: tokenId,
          requestId,
          expiresAt: new Date("2000-01-01T00:00:00.000Z"),
          createdAt: new Date(),
        }),
      },
      requestRepository: { findById: vi.fn().mockResolvedValue(makeRequest()) },
      clientRepository: { findById: vi.fn().mockResolvedValue(makeClient()) },
      agentRepository: { findById: vi.fn().mockResolvedValue(makeAgent()) },
    });

    await expect(service.getReviewSummaryByToken(tokenId)).resolves.toMatchObject({
      clientEmail: "client@test.com",
      agentId,
      agentName: "Agent One",
      tokenStatus: "expired",
    });
  });

  it("returns not found when the owner approves a missing request", async () => {
    const service = makeService({
      requestRepository: { findById: vi.fn().mockResolvedValue(null) },
    });
    const result = await service.approveByOwner(ownerUserId, requestId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("returns not found when the owner does not own the agent", async () => {
    const service = makeService({
      requestRepository: { findById: vi.fn().mockResolvedValue(makeRequest()) },
      identityRepository: { findOwnerUserId: vi.fn().mockResolvedValue(null) },
    });
    const result = await service.approveByOwner(ownerUserId, requestId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result).toEqual(expect.objectContaining({ ok: false }));
      expect(result.error.code).toBe(notFound(`Agent ${agentId}`).code);
    }
  });

  it("returns conflict when owner approval is no longer pending", async () => {
    const service = makeService({
      requestRepository: { findById: vi.fn().mockResolvedValue(makeRequest("approved")) },
      identityRepository: { findOwnerUserId: vi.fn().mockResolvedValue(ownerUserId) },
    });
    const result = await service.approveByOwner(ownerUserId, requestId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("uses the optimized owner-managed client page when the repository provides it", async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    const listOwnerManagedClientsPageByAgentId = vi.fn().mockResolvedValue(page);
    const service = makeService({
      identityRepository: { findOwnerUserId: vi.fn().mockResolvedValue(ownerUserId) },
      accessRepository: { listOwnerManagedClientsPageByAgentId },
    });

    const result = await service.listAgentClientsByOwnerPage(ownerUserId, agentId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(page);
    }
    expect(listOwnerManagedClientsPageByAgentId).toHaveBeenCalledWith(agentId, undefined);
  });

  it("returns already processed when owner reject loses the race", async () => {
    const service = makeService({
      requestRepository: { findById: vi.fn().mockResolvedValue(makeRequest()) },
      identityRepository: { findOwnerUserId: vi.fn().mockResolvedValue(ownerUserId) },
      approvalTxn: { rejectPendingAndConsumeToken: vi.fn().mockResolvedValue(false) },
    });
    const result = await service.rejectByOwner(ownerUserId, requestId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });
});
