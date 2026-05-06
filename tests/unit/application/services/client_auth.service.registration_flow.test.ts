import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClientAuthService } from "../../../../src/application/services/client_auth.service";
import { Client } from "../../../../src/domain/entities/client.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import type {
  ClientRegistrationApprovalToken,
  IClientRegistrationApprovalTokenRepository,
} from "../../../../src/domain/repositories/client_registration_approval_token.repository.interface";
import { InMemoryClientPasswordRecoveryTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_password_recovery_token.repository";
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

class TestClientRegistrationApprovalTokenRepository implements IClientRegistrationApprovalTokenRepository {
  private readonly store = new Map<string, ClientRegistrationApprovalToken>();
  private readonly tokenIdByClientId = new Map<string, string>();
  failOnSave = false;

  async save(token: ClientRegistrationApprovalToken): Promise<void> {
    if (this.failOnSave) {
      throw new Error("token persistence failed");
    }
    const existingTokenId = this.tokenIdByClientId.get(token.clientId);
    if (existingTokenId) {
      this.store.delete(existingTokenId);
    }
    this.store.set(token.id, token);
    this.tokenIdByClientId.set(token.clientId, token.id);
  }

  async replaceForClientRetry(_client: Client, token: ClientRegistrationApprovalToken): Promise<void> {
    await this.save(token);
  }

  async findById(id: string): Promise<ClientRegistrationApprovalToken | null> {
    return this.store.get(id) ?? null;
  }

  async findReviewSummaryById(): Promise<null> {
    return null;
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
    sendClientRegistrationRequestToOwner.mockResolvedValue(undefined);
    sendClientRegistrationApproved.mockResolvedValue(undefined);
    sendClientRegistrationRejected.mockResolvedValue(undefined);
    userRepository = new InMemoryUserRepository();
    clientRepository = new InMemoryClientRepository();
    clientRegistrationApprovalTokenRepository = new TestClientRegistrationApprovalTokenRepository();

    service = new ClientAuthService(
      clientRepository,
      new InMemoryClientRefreshTokenRepository(),
      new InMemoryClientPasswordRecoveryTokenRepository(),
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
      {
        saveClientThumbnail: async () => ({
          url: "http://test.local/uploads/client-thumbnails/mock.webp",
          storageKey: "client-thumbnails/mock.webp",
        }),
        delete: async () => {},
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

  it("keeps rejection successful when notification email fails after registration rejection", async () => {
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
    expect((await clientRepository.findById(client.id))?.status).toBe("rejected");
  });

  it("reopens an eligible rejected client registration", async () => {
    const client = Client.create({
      id: "client-retry-id",
      userId: "owner-user-id",
      email: "retry-client@test.com",
      passwordHash: "hashed:ClientPwd1",
      name: "Retry",
      lastName: "Client",
      status: "rejected",
    });
    await clientRepository.save(client);

    const result = await service.retryRejectedRegistration({
      ownerEmail: "owner@test.com",
      email: client.email,
      password: "ClientPwd1",
    });

    expect(result).toEqual({ ok: true, value: { retried: true } });
    expect(sendClientRegistrationRequestToOwner).toHaveBeenCalledTimes(1);
    expect((await clientRepository.findById(client.id))?.status).toBe("pending");
    expect(clientRegistrationApprovalTokenRepository.count()).toBe(1);
  });

  it("returns false when the owner is no longer active for retry", async () => {
    const owner = await userRepository.findById("owner-user-id");
    expect(owner).not.toBeNull();
    await userRepository.save(
      User.create({
        id: owner!.id,
        email: owner!.email,
        passwordHash: owner!.passwordHash,
        role: owner!.role,
        status: "blocked",
        createdAt: owner!.createdAt,
        ...(owner!.celular !== undefined ? { celular: owner!.celular } : {}),
      }),
    );

    const client = Client.create({
      id: "client-owner-inactive-retry-id",
      userId: "owner-user-id",
      email: "retry-owner-inactive@test.com",
      passwordHash: "hashed:ClientPwd1",
      name: "Retry",
      lastName: "OwnerInactive",
      status: "rejected",
    });
    await clientRepository.save(client);

    const result = await service.retryRejectedRegistration({
      ownerEmail: "owner@test.com",
      email: client.email,
      password: "ClientPwd1",
    });

    expect(result).toEqual({ ok: true, value: { retried: false } });
    expect(sendClientRegistrationRequestToOwner).not.toHaveBeenCalled();
    expect((await clientRepository.findById(client.id))?.status).toBe("rejected");
  });

  it("rolls back retry when the new client approval token cannot be stored", async () => {
    clientRegistrationApprovalTokenRepository.failOnSave = true;
    const client = Client.create({
      id: "client-retry-rollback-id",
      userId: "owner-user-id",
      email: "retry-rollback@test.com",
      passwordHash: "hashed:ClientPwd1",
      name: "Retry",
      lastName: "Rollback",
      status: "rejected",
    });
    await clientRepository.save(client);

    const result = await service.retryRejectedRegistration({
      ownerEmail: "owner@test.com",
      email: client.email,
      password: "ClientPwd1",
    });

    expect(result).toEqual({ ok: true, value: { retried: false } });
    expect((await clientRepository.findById(client.id))?.status).toBe("rejected");
    expect(clientRegistrationApprovalTokenRepository.count()).toBe(0);
    expect(sendClientRegistrationRequestToOwner).not.toHaveBeenCalled();
  });
});
