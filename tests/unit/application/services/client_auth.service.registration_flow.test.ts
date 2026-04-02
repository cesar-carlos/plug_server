import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClientAuthService } from "../../../../src/application/services/client_auth.service";
import { Client } from "../../../../src/domain/entities/client.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import type {
  ClientRegistrationApprovalToken,
  IClientRegistrationApprovalTokenRepository,
} from "../../../../src/domain/repositories/client_registration_approval_token.repository.interface";
import { InMemoryClientRefreshTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_refresh_token.repository";
import { InMemoryClientRepository } from "../../../../src/infrastructure/repositories/in_memory_client.repository";
import { InMemoryUserRepository } from "../../../../src/infrastructure/repositories/in_memory_user.repository";
import { env } from "../../../../src/shared/config/env";

class FakePasswordHasher {
  async hash(plain: string): Promise<string> {
    return `hashed:${plain}`;
  }

  async compare(plain: string, hashedValue: string): Promise<boolean> {
    return hashedValue === `hashed:${plain}`;
  }
}

class TestClientRegistrationApprovalTokenRepository
  implements IClientRegistrationApprovalTokenRepository
{
  private readonly store = new Map<string, ClientRegistrationApprovalToken>();
  private readonly tokenIdByClientId = new Map<string, string>();

  async save(token: ClientRegistrationApprovalToken): Promise<void> {
    const existingTokenId = this.tokenIdByClientId.get(token.clientId);
    if (existingTokenId) {
      this.store.delete(existingTokenId);
    }
    this.store.set(token.id, token);
    this.tokenIdByClientId.set(token.clientId, token.id);
  }

  async findById(id: string): Promise<ClientRegistrationApprovalToken | null> {
    return this.store.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    const token = this.store.get(id);
    if (token) {
      this.tokenIdByClientId.delete(token.clientId);
    }
    this.store.delete(id);
  }

  count(): number {
    return this.store.size;
  }
}

describe("ClientAuthService registration flow", () => {
  const sendClientRegistrationRequestToOwner = vi.fn();
  const sendClientRegistrationApproved = vi.fn();
  const sendClientRegistrationRejected = vi.fn();

  let userRepository: InMemoryUserRepository;
  let clientRepository: InMemoryClientRepository;
  let clientRegistrationApprovalTokenRepository: TestClientRegistrationApprovalTokenRepository;
  let service: ClientAuthService;

  beforeEach(async () => {
    vi.clearAllMocks();
    userRepository = new InMemoryUserRepository();
    clientRepository = new InMemoryClientRepository();
    clientRegistrationApprovalTokenRepository = new TestClientRegistrationApprovalTokenRepository();

    service = new ClientAuthService(
      clientRepository,
      new InMemoryClientRefreshTokenRepository(),
      clientRegistrationApprovalTokenRepository,
      userRepository,
      new FakePasswordHasher(),
      {
        sendAdminApprovalRequest: async () => {},
        sendUserPendingRegistration: async () => {},
        sendUserApproved: async () => {},
        sendUserRejected: async () => {},
        sendClientAccessRequestToOwner: async () => {},
        sendClientAccessApproved: async () => {},
        sendClientAccessRejected: async () => {},
        sendClientRegistrationRequestToOwner,
        sendClientRegistrationApproved,
        sendClientRegistrationRejected,
      },
    );

    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = false;
    (env as { registrationEmailMaxRetries: number }).registrationEmailMaxRetries = 3;
    (env as { registrationEmailRetryDelayMs: number }).registrationEmailRetryDelayMs = 0;

    await userRepository.save(
      User.create({
        id: "owner-user-id",
        email: "owner@test.com",
        passwordHash: "owner-hash",
        role: "user",
        status: "active",
      }),
    );
  });

  it("rolls back pending client registration when owner email delivery fails", async () => {
    sendClientRegistrationRequestToOwner.mockRejectedValue(new Error("smtp hard failure"));

    await expect(
      service.register({
        ownerEmail: "owner@test.com",
        email: "client@test.com",
        password: "ClientPwd1",
        name: "Client",
        lastName: "Pending",
      }),
    ).rejects.toThrow("sendClientRegistrationRequestToOwner failed after 3 attempts");

    expect(sendClientRegistrationRequestToOwner).toHaveBeenCalledTimes(3);
    expect(await clientRepository.findByEmail("client@test.com")).toBeNull();
    expect(clientRegistrationApprovalTokenRepository.count()).toBe(0);
  });

  it("keeps approval successful when notification email fails after activation", async () => {
    sendClientRegistrationApproved.mockRejectedValue(new Error("smtp notify failure"));

    const client = Client.create({
      id: "client-approved-id",
      userId: "owner-user-id",
      email: "approved@test.com",
      passwordHash: "hashed:ClientPwd1",
      name: "Approved",
      lastName: "Client",
      status: "pending",
    });
    await clientRepository.save(client);
    await clientRegistrationApprovalTokenRepository.save({
      id: "approval-token-approved-0123456789",
      clientId: client.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.approveRegistration("approval-token-approved-0123456789");

    expect(result.ok).toBe(true);
    expect(sendClientRegistrationApproved).toHaveBeenCalledWith({
      clientEmail: "approved@test.com",
    });
    expect((await clientRepository.findById(client.id))?.status).toBe("active");
  });

  it("keeps rejection successful when notification email fails after blocking", async () => {
    sendClientRegistrationRejected.mockRejectedValue(new Error("smtp notify failure"));

    const client = Client.create({
      id: "client-rejected-id",
      userId: "owner-user-id",
      email: "rejected@test.com",
      passwordHash: "hashed:ClientPwd1",
      name: "Rejected",
      lastName: "Client",
      status: "pending",
    });
    await clientRepository.save(client);
    await clientRegistrationApprovalTokenRepository.save({
      id: "approval-token-rejected-0123456789",
      clientId: client.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.rejectRegistration("approval-token-rejected-0123456789", "No fit");

    expect(result.ok).toBe(true);
    expect(sendClientRegistrationRejected).toHaveBeenCalledWith({
      clientEmail: "rejected@test.com",
      reason: "No fit",
    });
    expect((await clientRepository.findById(client.id))?.status).toBe("blocked");
  });
});
