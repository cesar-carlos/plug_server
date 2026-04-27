import { beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "../../../../src/domain/entities/client.entity";
import { Agent } from "../../../../src/domain/entities/agent.entity";
import { ClientAgentAccessRequest } from "../../../../src/domain/entities/client_agent_access_request.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import type { IEmailSender } from "../../../../src/domain/ports/email_sender.port";
import { ClientAgentAccessService } from "../../../../src/application/services/client_agent_access.service";
import { InMemoryAgentIdentityRepository } from "../../../../src/infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryAgentRepository } from "../../../../src/infrastructure/repositories/in_memory_agent.repository";
import { InMemoryClientAgentAccessApprovalTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access_approval_token.repository";
import { InMemoryClientAgentAccessRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access.repository";
import { InMemoryClientAgentAccessRequestRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access_request.repository";
import { InMemoryClientRepository } from "../../../../src/infrastructure/repositories/in_memory_client.repository";
import { InMemoryUserRepository } from "../../../../src/infrastructure/repositories/in_memory_user.repository";
import { clientAgentAccessRevokedByClientDecisionReason } from "../../../../src/application/services/client_agent_access_decision_reasons";
import { SequentialPendingClientAgentAccessWriter } from "../../../../src/infrastructure/persistence/sequential_pending_client_agent_access.writer";
import { env } from "../../../../src/shared/config/env";

class FakeEmailSender implements IEmailSender {
  ownerAccessRequests: Array<{
    ownerEmail: string;
    clientEmail: string;
    agentId: string;
    token: string;
  }> = [];
  clientApproved: Array<{ clientEmail: string; agentId: string }> = [];
  clientRejected: Array<{ clientEmail: string; agentId: string; reason?: string }> = [];

  async sendAdminApprovalRequest(): Promise<void> {}
  async sendUserPendingRegistration(): Promise<void> {}
  async sendUserApproved(): Promise<void> {}
  async sendUserRejected(): Promise<void> {}

  async sendClientAccessRequestToOwner(params: {
    readonly ownerEmail: string;
    readonly clientEmail: string;
    readonly clientName: string;
    readonly clientLastName: string;
    readonly agentId: string;
    readonly approvalToken: string;
  }): Promise<void> {
    this.ownerAccessRequests.push({
      ownerEmail: params.ownerEmail,
      clientEmail: params.clientEmail,
      agentId: params.agentId,
      token: params.approvalToken,
    });
  }

  async sendClientAccessApproved(params: {
    readonly clientEmail: string;
    readonly agentId: string;
  }): Promise<void> {
    this.clientApproved.push(params);
  }

  async sendClientAccessRejected(params: {
    readonly clientEmail: string;
    readonly agentId: string;
    readonly reason?: string;
  }): Promise<void> {
    this.clientRejected.push(params);
  }

  async sendClientRegistrationRequestToOwner(): Promise<void> {}
  async sendClientRegistrationApproved(): Promise<void> {}
  async sendClientRegistrationRejected(): Promise<void> {}
  async sendClientPasswordRecovery(): Promise<void> {}
}

describe("ClientAgentAccessService", () => {
  const ownerUserId = "35fdbf4a-8f33-45b6-a53b-a2cfd7a52d3f";
  const clientId = "f61cbcc5-f036-43b8-b1da-f5f8579580a4";
  const otherClientId = "8f4ed539-4da6-4862-bfcf-d4a5dbf9e8aa";
  const agentId = "8cb4f6a0-b04f-4c1c-ba34-383ec25003ce";

  let userRepository: InMemoryUserRepository;
  let clientRepository: InMemoryClientRepository;
  let agentRepository: InMemoryAgentRepository;
  let identityRepository: InMemoryAgentIdentityRepository;
  let accessRepository: InMemoryClientAgentAccessRepository;
  let requestRepository: InMemoryClientAgentAccessRequestRepository;
  let tokenRepository: InMemoryClientAgentAccessApprovalTokenRepository;
  let emailSender: FakeEmailSender;
  let service: ClientAgentAccessService;

  beforeEach(async () => {
    (env as { clientAgentAccessRequestEmailDebounceMs: number }).clientAgentAccessRequestEmailDebounceMs =
      60_000;

    userRepository = new InMemoryUserRepository();
    clientRepository = new InMemoryClientRepository();
    agentRepository = new InMemoryAgentRepository();
    identityRepository = new InMemoryAgentIdentityRepository();
    accessRepository = new InMemoryClientAgentAccessRepository();
    requestRepository = new InMemoryClientAgentAccessRequestRepository();
    tokenRepository = new InMemoryClientAgentAccessApprovalTokenRepository({
      findRequestById: (id) => requestRepository.findById(id),
      findClientById: (id) => clientRepository.findById(id),
      findAgentById: (id) => agentRepository.findById(id),
    });
    emailSender = new FakeEmailSender();

    const pendingWriter = new SequentialPendingClientAgentAccessWriter(
      requestRepository,
      tokenRepository,
    );
    service = new ClientAgentAccessService(
      agentRepository,
      identityRepository,
      clientRepository,
      userRepository,
      accessRepository,
      requestRepository,
      tokenRepository,
      emailSender,
      pendingWriter,
    );

    await userRepository.save(
      User.create({
        id: ownerUserId,
        email: "owner@example.com",
        passwordHash: "hash",
        role: "user",
        status: "active",
      }),
    );

    await clientRepository.save(
      Client.create({
        id: clientId,
        userId: ownerUserId,
        email: "client@example.com",
        passwordHash: "hash",
        name: "Client",
        lastName: "One",
        status: "active",
      }),
    );
    await clientRepository.save(
      Client.create({
        id: otherClientId,
        userId: ownerUserId,
        email: "other-client@example.com",
        passwordHash: "hash",
        name: "Other",
        lastName: "Client",
        status: "active",
      }),
    );

    await agentRepository.save(
      Agent.create({
        agentId,
        name: "Agent A",
      }),
    );
    await identityRepository.bindIfUnbound(agentId, ownerUserId);
  });

  it("should reject request when agent does not exist", async () => {
    const result = await service.requestAccess(clientId, ["f6f3f9f2-2533-4bb7-b595-b078f5b742cb"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("should create request and notify owner", async () => {
    const result = await service.requestAccess(clientId, [agentId]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requested).toEqual([agentId]);
      expect(result.value.alreadyApproved).toEqual([]);
      expect(result.value.newRequests).toEqual([agentId]);
      expect(result.value.reopened).toEqual([]);
      expect(result.value.debounced).toEqual([]);
    }
    expect(emailSender.ownerAccessRequests).toHaveLength(1);
    expect(emailSender.ownerAccessRequests[0]?.ownerEmail).toBe("owner@example.com");
    expect(emailSender.ownerAccessRequests[0]?.clientEmail).toBe("client@example.com");
  });

  it("should approve request and notify client", async () => {
    const requestResult = await service.requestAccess(clientId, [agentId]);
    expect(requestResult.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const approved = await service.approveByToken(token!);
    expect(approved.ok).toBe(true);
    expect(emailSender.clientApproved).toHaveLength(1);

    const hasAccess = await accessRepository.hasAccess(clientId, agentId);
    expect(hasAccess).toBe(true);
  });

  it("reopens pending when access row was removed after a prior approval", async () => {
    const requestResult = await service.requestAccess(clientId, [agentId]);
    expect(requestResult.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const approved = await service.approveByToken(token!);
    expect(approved.ok).toBe(true);
    expect(await accessRepository.hasAccess(clientId, agentId)).toBe(true);

    await accessRepository.removeAccess(clientId, agentId);
    expect(await accessRepository.hasAccess(clientId, agentId)).toBe(false);

    emailSender.ownerAccessRequests = [];

    const again = await service.requestAccess(clientId, [agentId]);
    expect(again.ok).toBe(true);
    if (!again.ok) {
      return;
    }
    expect(again.value.requested).toEqual([agentId]);
    expect(again.value.alreadyApproved).toEqual([]);
    expect(again.value.newRequests).toEqual([]);
    expect(again.value.reopened).toEqual([agentId]);
    expect(again.value.debounced).toEqual([]);
    expect(emailSender.ownerAccessRequests).toHaveLength(1);

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("pending");
  });

  it("marks access request revoked when client removes approved access", async () => {
    const requestResult = await service.requestAccess(clientId, [agentId]);
    expect(requestResult.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    const approved = await service.approveByToken(token!);
    expect(approved.ok).toBe(true);

    const remove = await service.removeApprovedAccess(clientId, [agentId]);
    expect(remove.ok).toBe(true);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("revoked");
    expect(stored?.decisionReason).toBe(clientAgentAccessRevokedByClientDecisionReason);
  });

  it("should reset decision metadata when reopening a processed request", async () => {
    const initialRequest = await service.requestAccess(clientId, [agentId]);
    expect(initialRequest.ok).toBe(true);

    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const rejected = await service.rejectByToken(token!, "Needs review");
    expect(rejected.ok).toBe(true);

    const reopened = await service.requestAccess(clientId, [agentId]);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) {
      return;
    }
    expect(reopened.value.reopened).toEqual([agentId]);
    expect(reopened.value.newRequests).toEqual([]);

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("pending");
    expect(stored?.decidedAt).toBeUndefined();
    expect(stored?.decisionReason).toBeUndefined();
  });

  it("returns 404 when another client tries to retry the request", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const retried = await service.retryRequestByClient(otherClientId, stored!.id);
    expect(retried.ok).toBe(false);
    if (!retried.ok) {
      expect(retried.error.code).toBe("NOT_FOUND");
    }
  });

  it("debounces retry while the request is still pending", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    emailSender.ownerAccessRequests = [];

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const retried = await service.retryRequestByClient(clientId, stored!.id);
    expect(retried.ok).toBe(true);
    if (!retried.ok) {
      return;
    }
    expect(retried.value.requested).toEqual([]);
    expect(retried.value.debounced).toEqual([agentId]);
    expect(emailSender.ownerAccessRequests).toHaveLength(0);
  });

  it("returns alreadyApproved when retrying an approved request with active access", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const approved = await service.approveByToken(token!);
    expect(approved.ok).toBe(true);
    emailSender.ownerAccessRequests = [];

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("approved");

    const retried = await service.retryRequestByClient(clientId, stored!.id);
    expect(retried.ok).toBe(true);
    if (!retried.ok) {
      return;
    }
    expect(retried.value).toEqual({
      requested: [],
      alreadyApproved: [agentId],
      newRequests: [],
      reopened: [],
      debounced: [],
    });
    expect(emailSender.ownerAccessRequests).toHaveLength(0);
  });

  it("removes the public approval token when the owner approves by inbox route", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const approved = await service.approveByOwner(ownerUserId, stored!.id);
    expect(approved.ok).toBe(true);
    await expect(tokenRepository.findById(token!)).resolves.toBeNull();
  });

  it("removes the public approval token when the owner rejects by inbox route", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const rejected = await service.rejectByOwner(ownerUserId, stored!.id, "No access");
    expect(rejected.ok).toBe(true);
    await expect(tokenRepository.findById(token!)).resolves.toBeNull();
  });

  it("should prefer live profile refresh for approved online agents", async () => {
    await accessRepository.addAccess(clientId, agentId);
    const refreshed = Agent.create({
      agentId,
      name: "Agent A Online",
      tradeName: "Online Trade",
      document: "11222333000181",
    });
    const refreshAgentProfile = vi.fn(async () => refreshed);
    const pendingWriter = new SequentialPendingClientAgentAccessWriter(
      requestRepository,
      tokenRepository,
    );
    service = new ClientAgentAccessService(
      agentRepository,
      identityRepository,
      clientRepository,
      userRepository,
      accessRepository,
      requestRepository,
      tokenRepository,
      emailSender,
      pendingWriter,
      {
        isAgentOnline: (requestedAgentId) => requestedAgentId === agentId,
        refreshAgentProfile,
      },
    );

    const result = await service.findApprovedAgent(clientId, agentId);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.name).toBe("Agent A Online");
    expect(result.value.tradeName).toBe("Online Trade");
    expect(refreshAgentProfile).toHaveBeenCalledWith(agentId);
  });

  it("should fall back to persisted snapshot when live refresh fails", async () => {
    await accessRepository.addAccess(clientId, agentId);
    const refreshAgentProfile = vi.fn(async () => {
      throw new Error("agent.getProfile failed");
    });
    const pendingWriter = new SequentialPendingClientAgentAccessWriter(
      requestRepository,
      tokenRepository,
    );
    service = new ClientAgentAccessService(
      agentRepository,
      identityRepository,
      clientRepository,
      userRepository,
      accessRepository,
      requestRepository,
      tokenRepository,
      emailSender,
      pendingWriter,
      {
        isAgentOnline: (requestedAgentId) => requestedAgentId === agentId,
        refreshAgentProfile,
      },
    );

    const result = await service.findApprovedAgent(clientId, agentId);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.name).toBe("Agent A");
    expect(refreshAgentProfile).toHaveBeenCalledWith(agentId);
  });

  it("returns not found when client does not exist for requestAccess", async () => {
    const result = await service.requestAccess("00000000-0000-4000-8000-000000000099", [agentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("returns forbidden when client account is not active", async () => {
    await clientRepository.save(
      Client.create({
        id: clientId,
        userId: ownerUserId,
        email: "client@example.com",
        passwordHash: "hash",
        name: "Client",
        lastName: "One",
        status: "blocked",
      }),
    );
    const result = await service.requestAccess(clientId, [agentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("returns review summary by approval token (findReviewSummaryById path)", async () => {
    await service.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const summary = await service.getReviewSummaryByToken(tokenId!);
    expect(summary).not.toBeNull();
    expect(summary?.clientEmail).toBe("client@example.com");
    expect(summary?.agentId).toBe(agentId);
    expect(summary?.agentName).toBe("Agent A");
    expect(summary?.requestStatus).toBe("pending");
    expect(summary?.tokenStatus).toBe("pending");
  });

  it("getReviewSummaryByToken marks tokenStatus expired when summary expiresAt is past", async () => {
    await service.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await tokenRepository.findById(tokenId!);
    expect(stored).not.toBeNull();
    await tokenRepository.save({
      ...stored!,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const summary = await service.getReviewSummaryByToken(tokenId!);
    expect(summary?.tokenStatus).toBe("expired");
    expect(summary?.requestStatus).toBe("pending");
  });

  it("returns null for unknown review token", async () => {
    await expect(service.getReviewSummaryByToken("totally-unknown-token")).resolves.toBeNull();
  });

  it("getRequestStatusByToken returns NOT_FOUND for unknown token", async () => {
    const r = await service.getRequestStatusByToken("missing-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("getRequestStatusByToken returns expired when token is past expiresAt", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await tokenRepository.findById(tokenId!);
    expect(stored).not.toBeNull();
    await tokenRepository.save({
      ...stored!,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const r = await service.getRequestStatusByToken(tokenId!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe("expired");
    }
  });

  it("getRequestStatusByToken returns request status when token is valid", async () => {
    await service.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const r = await service.getRequestStatusByToken(tokenId!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe("pending");
    }
  });

  it("getRequestStatusByToken returns NOT_FOUND when request row is missing", async () => {
    await tokenRepository.save({
      id: "orphan-access-token",
      requestId: "00000000-0000-4000-8000-0000000000bb",
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
    });
    const r = await service.getRequestStatusByToken("orphan-access-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("lists access requests for owner inbox", async () => {
    await service.requestAccess(clientId, [agentId]);
    const page = await service.listRequestsByOwnerPage(ownerUserId, {
      status: "pending",
      page: 1,
      pageSize: 10,
    });
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.total).toBeGreaterThanOrEqual(1);
      expect(page.value.items.some((i) => i.agentId === agentId)).toBe(true);
    }
  });

  it("lists clients connected to an agent for the owning user with search", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    const approved = await service.approveByToken(token!);
    expect(approved.ok).toBe(true);

    const page = await service.listAgentClientsByOwnerPage(ownerUserId, agentId, {
      search: "client@exam",
      page: 1,
      pageSize: 10,
    });
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.total).toBe(1);
      expect(page.value.items[0]?.email).toBe("client@example.com");
    }
  });

  it("revokes approved access by owner", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    await service.approveByToken(token!);
    expect(await accessRepository.hasAccess(clientId, agentId)).toBe(true);

    const revoked = await service.revokeAccessByOwner(ownerUserId, agentId, clientId);
    expect(revoked.ok).toBe(true);
    expect(await accessRepository.hasAccess(clientId, agentId)).toBe(false);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("revoked");
  });

  it("denies revoke by owner when caller does not own the agent", async () => {
    const otherOwnerId = "11111111-1111-4111-8111-111111111111";
    await userRepository.save(
      User.create({
        id: otherOwnerId,
        email: "stranger@example.com",
        passwordHash: "hash",
        role: "user",
        status: "active",
      }),
    );
    const revoked = await service.revokeAccessByOwner(otherOwnerId, agentId, clientId);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) {
      expect(revoked.error.code).toBe("AGENT_ACCESS_DENIED");
    }
  });

  it("returns conflict when retrying an approved request that no longer has an access row", async () => {
    const created = await service.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    await service.approveByToken(token!);
    await accessRepository.removeAccess(clientId, agentId);

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("approved");

    const retried = await service.retryRequestByClient(clientId, stored!.id);
    expect(retried.ok).toBe(false);
    if (!retried.ok) {
      expect(retried.error.code).toBe("CONFLICT");
    }
  });

  it("returns registration expired when approveByToken is past expiresAt", async () => {
    await service.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await tokenRepository.findById(tokenId!);
    expect(stored).not.toBeNull();
    await tokenRepository.save({
      ...stored!,
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = await service.approveByToken(tokenId!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REGISTRATION_TOKEN_EXPIRED");
    }
  });

  it("returns conflict when owner approves the same request twice", async () => {
    await service.requestAccess(clientId, [agentId]);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const first = await service.approveByOwner(ownerUserId, stored!.id);
    expect(first.ok).toBe(true);
    const second = await service.approveByOwner(ownerUserId, stored!.id);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });

  it("rejectByToken notifies client and sets request rejected", async () => {
    await service.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const rejected = await service.rejectByToken(tokenId!, "Policy");
    expect(rejected.ok).toBe(true);
    expect(emailSender.clientRejected).toHaveLength(1);
    expect(emailSender.clientRejected[0]).toMatchObject({
      clientEmail: "client@example.com",
      agentId,
      reason: "Policy",
    });
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("rejected");
    expect(stored?.decisionReason).toBe("Policy");
  });

  it("rejectByToken returns REGISTRATION_TOKEN_EXPIRED when link is past expiresAt", async () => {
    await service.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await tokenRepository.findById(tokenId!);
    await tokenRepository.save({
      ...stored!,
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = await service.rejectByToken(tokenId!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REGISTRATION_TOKEN_EXPIRED");
    }
  });

  it("rejectByToken returns CONFLICT when request is no longer pending", async () => {
    await service.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();
    await requestRepository.setStatus(stored!.id, "approved");

    const r = await service.rejectByToken(tokenId!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CONFLICT");
    }
    await expect(tokenRepository.findById(tokenId!)).resolves.toBeNull();
  });

  it("rejectByOwner denies when caller does not own the agent", async () => {
    const otherOwnerId = "22222222-2222-4222-8222-222222222222";
    await userRepository.save(
      User.create({
        id: otherOwnerId,
        email: "other-owner@example.com",
        passwordHash: "hash",
        role: "user",
        status: "active",
      }),
    );
    await service.requestAccess(clientId, [agentId]);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const r = await service.rejectByOwner(otherOwnerId, stored!.id, "No");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AGENT_ACCESS_DENIED");
    }
  });

  it("rejectByOwner returns CONFLICT when request was already processed", async () => {
    await service.requestAccess(clientId, [agentId]);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const first = await service.rejectByOwner(ownerUserId, stored!.id, "Once");
    expect(first.ok).toBe(true);
    const second = await service.rejectByOwner(ownerUserId, stored!.id, "Twice");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });

  it("approveByToken returns NOT_FOUND for unknown token", async () => {
    const r = await service.approveByToken("unknown-approval-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("approveByToken deletes token and returns NOT_FOUND when request row is missing", async () => {
    await tokenRepository.save({
      id: "orphan-approve-token",
      requestId: "00000000-0000-4000-8000-00000000c0de",
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
    });
    const r = await service.approveByToken("orphan-approve-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
    await expect(tokenRepository.findById("orphan-approve-token")).resolves.toBeNull();
  });

  it("approveByToken returns CONFLICT when request is no longer pending", async () => {
    await service.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();
    await requestRepository.setStatus(stored!.id, "rejected", { reason: "x" });

    const r = await service.approveByToken(tokenId!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CONFLICT");
    }
    await expect(tokenRepository.findById(tokenId!)).resolves.toBeNull();
  });

  it("approveByToken returns NOT_FOUND when client row is missing after access write", async () => {
    const missingClientId = "99999999-9999-4999-8999-999999999999";
    const pending = ClientAgentAccessRequest.create({
      clientId: missingClientId,
      agentId,
    });
    await requestRepository.save(pending);
    await tokenRepository.save({
      id: "approve-missing-client-token",
      requestId: pending.id,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
    });
    const r = await service.approveByToken("approve-missing-client-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejectByToken returns NOT_FOUND for unknown token", async () => {
    const r = await service.rejectByToken("missing-reject-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejectByToken deletes token and returns NOT_FOUND when request row is missing", async () => {
    await tokenRepository.save({
      id: "orphan-reject-token",
      requestId: "00000000-0000-4000-8000-00000000dead",
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
    });
    const r = await service.rejectByToken("orphan-reject-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
    await expect(tokenRepository.findById("orphan-reject-token")).resolves.toBeNull();
  });

  it("rejectByToken returns NOT_FOUND when client row is missing", async () => {
    const missingClientId = "88888888-8888-4888-8888-888888888888";
    const pending = ClientAgentAccessRequest.create({
      clientId: missingClientId,
      agentId,
    });
    await requestRepository.save(pending);
    await tokenRepository.save({
      id: "reject-missing-client-token",
      requestId: pending.id,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
    });
    const r = await service.rejectByToken("reject-missing-client-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("getReviewSummaryByToken uses DB fallback when token repo has no summary deps", async () => {
    const bareTokenRepo = new InMemoryClientAgentAccessApprovalTokenRepository();
    const pendingWriter = new SequentialPendingClientAgentAccessWriter(
      requestRepository,
      bareTokenRepo,
    );
    const fallbackService = new ClientAgentAccessService(
      agentRepository,
      identityRepository,
      clientRepository,
      userRepository,
      accessRepository,
      requestRepository,
      bareTokenRepo,
      emailSender,
      pendingWriter,
    );
    await fallbackService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests.at(-1)?.token;
    expect(tokenId).toBeTruthy();
    const summary = await fallbackService.getReviewSummaryByToken(tokenId!);
    expect(summary).not.toBeNull();
    expect(summary?.clientEmail).toBe("client@example.com");
    expect(summary?.agentName).toBe("Agent A");
  });

  it("getReviewSummaryByToken returns null in fallback path when client was deleted", async () => {
    const bareTokenRepo = new InMemoryClientAgentAccessApprovalTokenRepository();
    const pendingWriter = new SequentialPendingClientAgentAccessWriter(
      requestRepository,
      bareTokenRepo,
    );
    const fallbackService = new ClientAgentAccessService(
      agentRepository,
      identityRepository,
      clientRepository,
      userRepository,
      accessRepository,
      requestRepository,
      bareTokenRepo,
      emailSender,
      pendingWriter,
    );
    await fallbackService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests.at(-1)?.token;
    expect(tokenId).toBeTruthy();
    await clientRepository.deleteById(clientId);
    await expect(fallbackService.getReviewSummaryByToken(tokenId!)).resolves.toBeNull();
  });

  it("revokeAccessByOwner returns NOT_FOUND when client does not exist", async () => {
    const r = await service.revokeAccessByOwner(
      ownerUserId,
      agentId,
      "00000000-0000-4000-8000-0000000000cc",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("approveByOwner returns NOT_FOUND when request id is unknown", async () => {
    const r = await service.approveByOwner(ownerUserId, "00000000-0000-4000-8000-0000000000dd");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("approveByOwner returns NOT_FOUND when client row is missing", async () => {
    const missingClientId = "77777777-7777-4777-8777-777777777777";
    const pending = ClientAgentAccessRequest.create({
      clientId: missingClientId,
      agentId,
    });
    await requestRepository.save(pending);
    const r = await service.approveByOwner(ownerUserId, pending.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejectByOwner returns NOT_FOUND when request id is unknown", async () => {
    const r = await service.rejectByOwner(ownerUserId, "00000000-0000-4000-8000-0000000000ee");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejectByOwner returns NOT_FOUND when client row is missing", async () => {
    const missingClientId = "66666666-6666-4666-8666-666666666666";
    const pending = ClientAgentAccessRequest.create({
      clientId: missingClientId,
      agentId,
    });
    await requestRepository.save(pending);
    const r = await service.rejectByOwner(ownerUserId, pending.id, "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });
});
