import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "../../../../src/domain/entities/client.entity";
import { Agent } from "../../../../src/domain/entities/agent.entity";
import { ClientAgentAccessRequest } from "../../../../src/domain/entities/client_agent_access_request.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import type { IEmailSender } from "../../../../src/domain/ports/email_sender.port";
import type {
  ClientAgentAccessApproveTxnInput,
  ClientAgentAccessRejectTxnInput,
  IClientAgentAccessApprovalTxn,
} from "../../../../src/domain/ports/client_agent_access_approval_txn.port";
import { ClientAgentAccessQueryService } from "../../../../src/application/services/client_agent_access_query.service";
import { ClientAgentAccessRequestService } from "../../../../src/application/services/client_agent_access_request.service";
import { ClientAgentAccessDecisionService } from "../../../../src/application/services/client_agent_access_decision.service";
import { InMemoryAgentIdentityRepository } from "../../../../src/infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryAgentRepository } from "../../../../src/infrastructure/repositories/in_memory_agent.repository";
import { InMemoryClientAgentAccessApprovalTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access_approval_token.repository";
import { InMemoryClientAgentAccessRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access.repository";
import { InMemoryClientAgentAccessRequestRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access_request.repository";
import { InMemoryClientRepository } from "../../../../src/infrastructure/repositories/in_memory_client.repository";
import { InMemoryUserRepository } from "../../../../src/infrastructure/repositories/in_memory_user.repository";
import { clientAgentAccessRevokedByClientDecisionReason } from "../../../../src/application/services/client_agent_access_decision_reasons";
import { registerConsumerSocketControlHandler } from "../../../../src/application/services/consumer_socket_control_sink";
import { SequentialPendingClientAgentAccessWriter } from "../../../../src/infrastructure/persistence/sequential_pending_client_agent_access.writer";
import { InMemoryClientAgentAccessApprovalTxn } from "../../../../src/infrastructure/persistence/in_memory_client_agent_access_approval_txn";
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
  let approvalTxn: InMemoryClientAgentAccessApprovalTxn;
  let queryService: ClientAgentAccessQueryService;
  let requestService: ClientAgentAccessRequestService;
  let decisionService: ClientAgentAccessDecisionService;
  const socketControlDisposers: Array<() => void> = [];

  beforeEach(async () => {
    (
      env as { clientAgentAccessRequestEmailDebounceMs: number }
    ).clientAgentAccessRequestEmailDebounceMs = 60_000;

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
    approvalTxn = new InMemoryClientAgentAccessApprovalTxn(
      requestRepository,
      accessRepository,
      tokenRepository,
    );
    queryService = new ClientAgentAccessQueryService(
      agentRepository,
      clientRepository,
      accessRepository,
      requestRepository,
    );
    requestService = new ClientAgentAccessRequestService(
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
    decisionService = new ClientAgentAccessDecisionService(
      agentRepository,
      identityRepository,
      clientRepository,
      accessRepository,
      requestRepository,
      tokenRepository,
      emailSender,
      approvalTxn,
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

  afterEach(() => {
    while (socketControlDisposers.length > 0) {
      socketControlDisposers.pop()?.();
    }
  });

  it("should reject request when agent does not exist", async () => {
    const result = await requestService.requestAccess(clientId, [
      "f6f3f9f2-2533-4bb7-b595-b078f5b742cb",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("should create request and notify owner", async () => {
    const result = await requestService.requestAccess(clientId, [agentId]);
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
    const requestResult = await requestService.requestAccess(clientId, [agentId]);
    expect(requestResult.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const approved = await decisionService.approveByToken(token!);
    expect(approved.ok).toBe(true);
    expect(emailSender.clientApproved).toHaveLength(1);

    const hasAccess = await accessRepository.hasAccess(clientId, agentId);
    expect(hasAccess).toBe(true);
  });

  it("notifies hub to join client-agent room after token approval", async () => {
    const grantClientAccess = vi.fn().mockResolvedValue(undefined);
    socketControlDisposers.push(
      registerConsumerSocketControlHandler({
        disconnectPrincipal: vi.fn(),
        revokeClientAccess: vi.fn(),
        grantClientAccess,
      }),
    );

    const requestResult = await requestService.requestAccess(clientId, [agentId]);
    expect(requestResult.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const approved = await decisionService.approveByToken(token!);
    expect(approved.ok).toBe(true);
    expect(grantClientAccess).toHaveBeenCalledWith({
      clientId,
      agentId,
    });
  });

  it("reopens pending when access row was removed after a prior approval", async () => {
    const requestResult = await requestService.requestAccess(clientId, [agentId]);
    expect(requestResult.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const approved = await decisionService.approveByToken(token!);
    expect(approved.ok).toBe(true);
    expect(await accessRepository.hasAccess(clientId, agentId)).toBe(true);

    await accessRepository.removeAccess(clientId, agentId);
    expect(await accessRepository.hasAccess(clientId, agentId)).toBe(false);

    emailSender.ownerAccessRequests = [];

    const again = await requestService.requestAccess(clientId, [agentId]);
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
    const requestResult = await requestService.requestAccess(clientId, [agentId]);
    expect(requestResult.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    const approved = await decisionService.approveByToken(token!);
    expect(approved.ok).toBe(true);

    const remove = await requestService.removeApprovedAccess(clientId, [agentId]);
    expect(remove.ok).toBe(true);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("revoked");
    expect(stored?.decisionReason).toBe(clientAgentAccessRevokedByClientDecisionReason);
  });

  it("notifies sockets only for accesses that existed before client removal", async () => {
    const revokedEvents: Array<{ clientId: string; agentId: string }> = [];
    socketControlDisposers.push(
      registerConsumerSocketControlHandler({
        disconnectPrincipal: vi.fn(),
        revokeClientAccess: async (event) => {
          revokedEvents.push({ clientId: event.clientId, agentId: event.agentId });
        },
        grantClientAccess: vi.fn(),
      }),
    );

    await accessRepository.addAccess(clientId, agentId);

    const missingAgentId = "d74b7e1b-1b7d-4420-8751-b7a6d0df59bc";
    const remove = await requestService.removeApprovedAccess(clientId, [agentId, missingAgentId]);

    expect(remove.ok).toBe(true);
    expect(revokedEvents).toEqual([{ clientId, agentId }]);
  });

  it("does not notify sockets when client removal is idempotent and no access exists", async () => {
    const revokeClientAccess = vi.fn();
    socketControlDisposers.push(
      registerConsumerSocketControlHandler({
        disconnectPrincipal: vi.fn(),
        revokeClientAccess,
        grantClientAccess: vi.fn(),
      }),
    );

    const remove = await requestService.removeApprovedAccess(clientId, [agentId]);

    expect(remove.ok).toBe(true);
    expect(revokeClientAccess).not.toHaveBeenCalled();
  });

  it("should reset decision metadata when reopening a processed request", async () => {
    const initialRequest = await requestService.requestAccess(clientId, [agentId]);
    expect(initialRequest.ok).toBe(true);

    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const rejected = await decisionService.rejectByToken(token!, "Needs review");
    expect(rejected.ok).toBe(true);

    const reopened = await requestService.requestAccess(clientId, [agentId]);
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
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const retried = await requestService.retryRequestByClient(otherClientId, stored!.id);
    expect(retried.ok).toBe(false);
    if (!retried.ok) {
      expect(retried.error.code).toBe("NOT_FOUND");
    }
  });

  it("debounces retry while the request is still pending", async () => {
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    emailSender.ownerAccessRequests = [];

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const retried = await requestService.retryRequestByClient(clientId, stored!.id);
    expect(retried.ok).toBe(true);
    if (!retried.ok) {
      return;
    }
    expect(retried.value.requested).toEqual([]);
    expect(retried.value.debounced).toEqual([agentId]);
    expect(emailSender.ownerAccessRequests).toHaveLength(0);
  });

  it("does not increment retryCount when resending a pending request after debounce", async () => {
    const { env } = await import("../../../../src/shared/config/env");
    const previousDebounce = env.clientAgentAccessRequestEmailDebounceMs;
    (
      env as { clientAgentAccessRequestEmailDebounceMs: number }
    ).clientAgentAccessRequestEmailDebounceMs = 1;
    try {
      const created = await requestService.requestAccess(clientId, [agentId]);
      expect(created.ok).toBe(true);
      const first = await requestRepository.findByClientAndAgent(clientId, agentId);
      expect(first?.retryCount).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 5));
      emailSender.ownerAccessRequests = [];

      const again = await requestService.requestAccess(clientId, [agentId]);
      expect(again.ok).toBe(true);
      if (!again.ok) {
        return;
      }
      expect(again.value.reopened).toEqual([agentId]);
      expect(emailSender.ownerAccessRequests).toHaveLength(1);

      const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
      expect(stored?.status).toBe("pending");
      expect(stored?.retryCount).toBe(0);
    } finally {
      (
        env as { clientAgentAccessRequestEmailDebounceMs: number }
      ).clientAgentAccessRequestEmailDebounceMs = previousDebounce;
    }
  });

  it("increments retryCount when retrying after rejection", async () => {
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    const rejected = await decisionService.rejectByToken(token!);
    expect(rejected.ok).toBe(true);

    emailSender.ownerAccessRequests = [];
    const again = await requestService.requestAccess(clientId, [agentId]);
    expect(again.ok).toBe(true);
    if (!again.ok) {
      return;
    }
    expect(again.value.reopened).toEqual([agentId]);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("pending");
    expect(stored?.retryCount).toBe(1);
  });

  it("marks pending request expired when public status is polled with an expired token", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const storedToken = await tokenRepository.findById(tokenId!);
    expect(storedToken).not.toBeNull();
    await tokenRepository.save({
      ...storedToken!,
      expiresAt: new Date(Date.now() - 1000),
    });

    const status = await decisionService.getRequestStatusByToken(tokenId!);
    expect(status.ok).toBe(true);
    if (!status.ok) {
      return;
    }
    expect(status.value).toEqual({ status: "expired" });

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("expired");
    // Token kept so a later approve/reject can still return 410.
    await expect(tokenRepository.findById(tokenId!)).resolves.not.toBeNull();
  });

  it("returns alreadyApproved when retrying an approved request with active access", async () => {
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const approved = await decisionService.approveByToken(token!);
    expect(approved.ok).toBe(true);
    emailSender.ownerAccessRequests = [];

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("approved");

    const retried = await requestService.retryRequestByClient(clientId, stored!.id);
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
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const approved = await decisionService.approveByOwner(ownerUserId, stored!.id);
    expect(approved.ok).toBe(true);
    await expect(tokenRepository.findById(token!)).resolves.toBeNull();
  });

  it("removes the public approval token when the owner rejects by inbox route", async () => {
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const rejected = await decisionService.rejectByOwner(ownerUserId, stored!.id, "No access");
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
    queryService = new ClientAgentAccessQueryService(
      agentRepository,
      clientRepository,
      accessRepository,
      requestRepository,
      {
        isAgentOnline: (requestedAgentId) => requestedAgentId === agentId,
        refreshAgentProfile,
      },
    );

    const result = await queryService.findApprovedAgent(clientId, agentId);

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
    queryService = new ClientAgentAccessQueryService(
      agentRepository,
      clientRepository,
      accessRepository,
      requestRepository,
      {
        isAgentOnline: (requestedAgentId) => requestedAgentId === agentId,
        refreshAgentProfile,
      },
    );

    const result = await queryService.findApprovedAgent(clientId, agentId);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.name).toBe("Agent A");
    expect(refreshAgentProfile).toHaveBeenCalledWith(agentId);
  });

  it("returns not found when client does not exist for requestAccess", async () => {
    const result = await requestService.requestAccess("00000000-0000-4000-8000-000000000099", [
      agentId,
    ]);
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
    const result = await requestService.requestAccess(clientId, [agentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("returns conflict when agent is not active", async () => {
    const inactiveAgentId = "b7f8d9e1-4c2a-4f8e-9d01-123456789abc";
    await agentRepository.save(
      Agent.create({
        agentId: inactiveAgentId,
        name: "Inactive agent",
        status: "inactive",
      }),
    );
    await identityRepository.bindIfUnbound(inactiveAgentId, ownerUserId);
    const result = await requestService.requestAccess(clientId, [inactiveAgentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("approveByToken returns forbidden when client account is no longer active", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests.at(-1)?.token;
    expect(tokenId).toBeTruthy();
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
    const r = await decisionService.approveByToken(tokenId!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("FORBIDDEN");
    }
  });

  it("returns review summary by approval token (findReviewSummaryById path)", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const summary = await decisionService.getReviewSummaryByToken(tokenId!);
    expect(summary).not.toBeNull();
    expect(summary?.clientEmail).toBe("client@example.com");
    expect(summary?.agentId).toBe(agentId);
    expect(summary?.agentName).toBe("Agent A");
    expect(summary?.requestStatus).toBe("pending");
    expect(summary?.tokenStatus).toBe("pending");
  });

  it("getReviewSummaryByToken marks tokenStatus expired when summary expiresAt is past", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await tokenRepository.findById(tokenId!);
    expect(stored).not.toBeNull();
    await tokenRepository.save({
      ...stored!,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const summary = await decisionService.getReviewSummaryByToken(tokenId!);
    expect(summary?.tokenStatus).toBe("expired");
    expect(summary?.requestStatus).toBe("pending");
  });

  it("returns null for unknown review token", async () => {
    await expect(
      decisionService.getReviewSummaryByToken("totally-unknown-token"),
    ).resolves.toBeNull();
  });

  it("getRequestStatusByToken returns NOT_FOUND for unknown token", async () => {
    const r = await decisionService.getRequestStatusByToken("missing-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("getRequestStatusByToken returns expired when token is past expiresAt", async () => {
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await tokenRepository.findById(tokenId!);
    expect(stored).not.toBeNull();
    await tokenRepository.save({
      ...stored!,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const r = await decisionService.getRequestStatusByToken(tokenId!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe("expired");
    }
  });

  it("getRequestStatusByToken returns request status when token is valid", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const r = await decisionService.getRequestStatusByToken(tokenId!);
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
    const r = await decisionService.getRequestStatusByToken("orphan-access-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("lists access requests for owner inbox", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const page = await decisionService.listRequestsByOwnerPage(ownerUserId, {
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
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    const approved = await decisionService.approveByToken(token!);
    expect(approved.ok).toBe(true);

    const page = await decisionService.listAgentClientsByOwnerPage(ownerUserId, agentId, {
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

  it("lists clients connected to an agent with stable approvedAt/clientId ordering", async () => {
    const approvedAt = new Date("2026-05-14T12:00:00.000Z");
    await accessRepository.addAccess(otherClientId, agentId, approvedAt);
    await accessRepository.addAccess(clientId, agentId, approvedAt);

    const firstPage = await decisionService.listAgentClientsByOwnerPage(ownerUserId, agentId, {
      page: 1,
      pageSize: 1,
    });
    const secondPage = await decisionService.listAgentClientsByOwnerPage(ownerUserId, agentId, {
      page: 2,
      pageSize: 1,
    });

    expect(firstPage.ok).toBe(true);
    expect(secondPage.ok).toBe(true);
    if (firstPage.ok && secondPage.ok) {
      const expectedOrder = [clientId, otherClientId].sort((left, right) =>
        left.localeCompare(right),
      );
      expect(firstPage.value.total).toBe(2);
      expect(secondPage.value.total).toBe(2);
      expect(firstPage.value.items[0]?.clientId).toBe(expectedOrder[0]);
      expect(secondPage.value.items[0]?.clientId).toBe(expectedOrder[1]);
    }
  });

  it("revokes approved access by owner", async () => {
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    await decisionService.approveByToken(token!);
    expect(await accessRepository.hasAccess(clientId, agentId)).toBe(true);

    const revoked = await decisionService.revokeAccessByOwner(ownerUserId, agentId, clientId);
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
    const revoked = await decisionService.revokeAccessByOwner(otherOwnerId, agentId, clientId);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) {
      expect(revoked.error.code).toBe("AGENT_ACCESS_DENIED");
    }
  });

  it("reopens request when status is approved but the access row was removed", async () => {
    const created = await requestService.requestAccess(clientId, [agentId]);
    expect(created.ok).toBe(true);
    const token = emailSender.ownerAccessRequests[0]?.token;
    expect(token).toBeTruthy();
    await decisionService.approveByToken(token!);
    await accessRepository.removeAccess(clientId, agentId);

    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored?.status).toBe("approved");

    const retried = await requestService.retryRequestByClient(clientId, stored!.id);
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.value.reopened).toEqual([agentId]);
    }
  });

  it("returns conflict when retry count reaches CLIENT_AGENT_ACCESS_MAX_RETRIES", async () => {
    const { env } = await import("../../../../src/shared/config/env");
    const maxRetries = (env as { clientAgentAccessMaxRetries: number }).clientAgentAccessMaxRetries;
    if (maxRetries <= 0) {
      return; // limit disabled; skip
    }

    // Seed a request already at the limit (retryCount = maxRetries).
    const existing = ClientAgentAccessRequest.create({
      clientId,
      agentId,
      status: "rejected",
      retryCount: maxRetries,
    });
    await requestRepository.save(existing);

    const result = await requestService.requestAccess(clientId, [agentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("returns registration expired when approveByToken is past expiresAt", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await tokenRepository.findById(tokenId!);
    expect(stored).not.toBeNull();
    await tokenRepository.save({
      ...stored!,
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = await decisionService.approveByToken(tokenId!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REGISTRATION_TOKEN_EXPIRED");
    }
  });

  it("returns conflict when owner approves the same request twice", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const first = await decisionService.approveByOwner(ownerUserId, stored!.id);
    expect(first.ok).toBe(true);
    const second = await decisionService.approveByOwner(ownerUserId, stored!.id);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });

  it("rejectByToken notifies client and sets request rejected", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const rejected = await decisionService.rejectByToken(tokenId!, "Policy");
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
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await tokenRepository.findById(tokenId!);
    await tokenRepository.save({
      ...stored!,
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = await decisionService.rejectByToken(tokenId!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REGISTRATION_TOKEN_EXPIRED");
    }
  });

  it("rejectByToken returns CONFLICT when request is no longer pending", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();
    await requestRepository.setStatus(stored!.id, "approved");

    const r = await decisionService.rejectByToken(tokenId!);
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
    await requestService.requestAccess(clientId, [agentId]);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const r = await decisionService.rejectByOwner(otherOwnerId, stored!.id, "No");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AGENT_ACCESS_DENIED");
    }
  });

  it("rejectByOwner returns CONFLICT when request was already processed", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();

    const first = await decisionService.rejectByOwner(ownerUserId, stored!.id, "Once");
    expect(first.ok).toBe(true);
    const second = await decisionService.rejectByOwner(ownerUserId, stored!.id, "Twice");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });

  it("approveByToken returns NOT_FOUND for unknown token", async () => {
    const r = await decisionService.approveByToken("unknown-approval-token");
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
    const r = await decisionService.approveByToken("orphan-approve-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
    await expect(tokenRepository.findById("orphan-approve-token")).resolves.toBeNull();
  });

  it("approveByToken returns CONFLICT when request is no longer pending", async () => {
    await requestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests[0]?.token;
    expect(tokenId).toBeTruthy();
    const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
    expect(stored).not.toBeNull();
    await requestRepository.setStatus(stored!.id, "rejected", { reason: "x" });

    const r = await decisionService.approveByToken(tokenId!);
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
    const r = await decisionService.approveByToken("approve-missing-client-token");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejectByToken returns NOT_FOUND for unknown token", async () => {
    const r = await decisionService.rejectByToken("missing-reject-token");
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
    const r = await decisionService.rejectByToken("orphan-reject-token");
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
    const r = await decisionService.rejectByToken("reject-missing-client-token");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.agentId).toBe(agentId);
      expect(r.value.clientEmail).toBe("");
    }
  });

  it("getReviewSummaryByToken uses DB fallback when token repo has no summary deps", async () => {
    const bareTokenRepo = new InMemoryClientAgentAccessApprovalTokenRepository();
    const pendingWriter = new SequentialPendingClientAgentAccessWriter(
      requestRepository,
      bareTokenRepo,
    );
    const fallbackApprovalTxn = new InMemoryClientAgentAccessApprovalTxn(
      requestRepository,
      accessRepository,
      bareTokenRepo,
    );
    const fallbackRequestService = new ClientAgentAccessRequestService(
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
    const fallbackDecisionService = new ClientAgentAccessDecisionService(
      agentRepository,
      identityRepository,
      clientRepository,
      accessRepository,
      requestRepository,
      bareTokenRepo,
      emailSender,
      fallbackApprovalTxn,
    );
    await fallbackRequestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests.at(-1)?.token;
    expect(tokenId).toBeTruthy();
    const summary = await fallbackDecisionService.getReviewSummaryByToken(tokenId!);
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
    const fallbackApprovalTxn = new InMemoryClientAgentAccessApprovalTxn(
      requestRepository,
      accessRepository,
      bareTokenRepo,
    );
    const fallbackRequestService = new ClientAgentAccessRequestService(
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
    const fallbackDecisionService = new ClientAgentAccessDecisionService(
      agentRepository,
      identityRepository,
      clientRepository,
      accessRepository,
      requestRepository,
      bareTokenRepo,
      emailSender,
      fallbackApprovalTxn,
    );
    await fallbackRequestService.requestAccess(clientId, [agentId]);
    const tokenId = emailSender.ownerAccessRequests.at(-1)?.token;
    expect(tokenId).toBeTruthy();
    await clientRepository.deleteById(clientId);
    await expect(fallbackDecisionService.getReviewSummaryByToken(tokenId!)).resolves.toBeNull();
  });

  it("revokeAccessByOwner returns NOT_FOUND when client does not exist", async () => {
    const r = await decisionService.revokeAccessByOwner(
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
    const r = await decisionService.approveByOwner(
      ownerUserId,
      "00000000-0000-4000-8000-0000000000dd",
    );
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
    const r = await decisionService.approveByOwner(ownerUserId, pending.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejectByOwner returns NOT_FOUND when request id is unknown", async () => {
    const r = await decisionService.rejectByOwner(
      ownerUserId,
      "00000000-0000-4000-8000-0000000000ee",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejectByOwner succeeds without notify when client row is missing", async () => {
    const missingClientId = "66666666-6666-4666-8666-666666666666";
    const pending = ClientAgentAccessRequest.create({
      clientId: missingClientId,
      agentId,
    });
    await requestRepository.save(pending);
    const r = await decisionService.rejectByOwner(ownerUserId, pending.id, "x");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.agentId).toBe(agentId);
      expect(r.value.clientEmail).toBe("");
    }
  });

  describe("approval transaction failures", () => {
    class BoomTxn implements IClientAgentAccessApprovalTxn {
      async approvePendingAndGrantAccess(
        _input: ClientAgentAccessApproveTxnInput,
      ): Promise<boolean> {
        throw new Error("simulated txn failure");
      }

      async rejectPendingAndConsumeToken(
        _input: ClientAgentAccessRejectTxnInput,
      ): Promise<boolean> {
        throw new Error("simulated txn failure");
      }
    }

    const createServiceWithApprovalTxn = (
      txn: IClientAgentAccessApprovalTxn,
    ): ClientAgentAccessDecisionService =>
      new ClientAgentAccessDecisionService(
        agentRepository,
        identityRepository,
        clientRepository,
        accessRepository,
        requestRepository,
        tokenRepository,
        emailSender,
        txn,
      );

    it("approveByToken returns SERVICE_UNAVAILABLE when txn throws", async () => {
      const requestResult = await requestService.requestAccess(clientId, [agentId]);
      expect(requestResult.ok).toBe(true);
      const token = emailSender.ownerAccessRequests.at(-1)?.token;
      expect(token).toBeTruthy();

      const r = await createServiceWithApprovalTxn(new BoomTxn()).approveByToken(token!);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("SERVICE_UNAVAILABLE");
      }
    });

    it("rejectByToken returns SERVICE_UNAVAILABLE when txn throws", async () => {
      const requestResult = await requestService.requestAccess(clientId, [agentId]);
      expect(requestResult.ok).toBe(true);
      const token = emailSender.ownerAccessRequests.at(-1)?.token;
      expect(token).toBeTruthy();

      const r = await createServiceWithApprovalTxn(new BoomTxn()).rejectByToken(token!);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("SERVICE_UNAVAILABLE");
      }
    });

    it("approveByOwner returns SERVICE_UNAVAILABLE when txn throws", async () => {
      const requestResult = await requestService.requestAccess(clientId, [agentId]);
      expect(requestResult.ok).toBe(true);
      const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
      expect(stored).not.toBeNull();

      const r = await createServiceWithApprovalTxn(new BoomTxn()).approveByOwner(
        ownerUserId,
        stored!.id,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("SERVICE_UNAVAILABLE");
      }
    });

    it("rejectByOwner returns SERVICE_UNAVAILABLE when txn throws", async () => {
      const requestResult = await requestService.requestAccess(clientId, [agentId]);
      expect(requestResult.ok).toBe(true);
      const stored = await requestRepository.findByClientAndAgent(clientId, agentId);
      expect(stored).not.toBeNull();

      const r = await createServiceWithApprovalTxn(new BoomTxn()).rejectByOwner(
        ownerUserId,
        stored!.id,
        "no",
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("SERVICE_UNAVAILABLE");
      }
    });
  });
});
