import { beforeEach, describe, expect, it } from "vitest";

import { Client } from "../../../../src/domain/entities/client.entity";
import { Agent } from "../../../../src/domain/entities/agent.entity";
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

class FakeEmailSender implements IEmailSender {
  ownerAccessRequests: Array<{ ownerEmail: string; clientEmail: string; agentId: string; token: string }> = [];
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
}

describe("ClientAgentAccessService", () => {
  const ownerUserId = "35fdbf4a-8f33-45b6-a53b-a2cfd7a52d3f";
  const clientId = "f61cbcc5-f036-43b8-b1da-f5f8579580a4";
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
    userRepository = new InMemoryUserRepository();
    clientRepository = new InMemoryClientRepository();
    agentRepository = new InMemoryAgentRepository();
    identityRepository = new InMemoryAgentIdentityRepository();
    accessRepository = new InMemoryClientAgentAccessRepository();
    requestRepository = new InMemoryClientAgentAccessRequestRepository();
    tokenRepository = new InMemoryClientAgentAccessApprovalTokenRepository();
    emailSender = new FakeEmailSender();

    service = new ClientAgentAccessService(
      agentRepository,
      identityRepository,
      clientRepository,
      userRepository,
      accessRepository,
      requestRepository,
      tokenRepository,
      emailSender,
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
});
