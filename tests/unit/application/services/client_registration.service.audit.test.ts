import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClientRegistrationService } from "../../../../src/application/services/client_registration.service";
import { Client } from "../../../../src/domain/entities/client.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import type { IClientRegistrationApprovalTokenRepository } from "../../../../src/domain/repositories/client_registration_approval_token.repository.interface";
import { InMemoryClientRegistrationDecisionTxn } from "../../../../src/infrastructure/persistence/in_memory_client_registration_decision_txn";
import { InMemoryClientRegistrationRegisterTxn } from "../../../../src/infrastructure/persistence/in_memory_client_registration_register_txn";
import { InMemoryClientRegistrationPollTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_registration_poll_token.repository";
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

class TestApprovalTokenRepository implements IClientRegistrationApprovalTokenRepository {
  private readonly store = new Map<
    string,
    { id: string; clientId: string; expiresAt: Date; createdAt: Date }
  >();
  private readonly tokenIdByClientId = new Map<string, string>();

  constructor(private readonly clientRepository?: InMemoryClientRepository) {}

  async save(token: {
    id: string;
    clientId: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<void> {
    const existing = this.tokenIdByClientId.get(token.clientId);
    if (existing) this.store.delete(existing);
    this.store.set(token.id, token);
    this.tokenIdByClientId.set(token.clientId, token.id);
  }

  async replaceForClientRetry(
    client: Client,
    token: { id: string; clientId: string; expiresAt: Date; createdAt: Date },
  ): Promise<void> {
    await this.save(token);
    if (this.clientRepository) {
      await this.clientRepository.save(client);
    }
  }

  async findById(
    id: string,
  ): Promise<{ id: string; clientId: string; expiresAt: Date; createdAt: Date } | null> {
    return this.store.get(id) ?? null;
  }

  async findByClientId(
    clientId: string,
  ): Promise<{ id: string; clientId: string; expiresAt: Date; createdAt: Date } | null> {
    const id = this.tokenIdByClientId.get(clientId);
    return id ? (this.store.get(id) ?? null) : null;
  }

  async findReviewSummaryById(): Promise<null> {
    return null;
  }

  async deleteById(id: string): Promise<void> {
    const token = this.store.get(id);
    if (token) this.tokenIdByClientId.delete(token.clientId);
    this.store.delete(id);
  }
}

describe("ClientRegistrationService audit fixes", () => {
  let userRepository: InMemoryUserRepository;
  let clientRepository: InMemoryClientRepository;
  let approvalTokenRepository: TestApprovalTokenRepository;
  let pollTokenRepository: InMemoryClientRegistrationPollTokenRepository;
  let service: ClientRegistrationService;

  beforeEach(async () => {
    vi.clearAllMocks();
    userRepository = new InMemoryUserRepository();
    clientRepository = new InMemoryClientRepository();
    approvalTokenRepository = new TestApprovalTokenRepository(clientRepository);
    pollTokenRepository = new InMemoryClientRegistrationPollTokenRepository();
    service = new ClientRegistrationService(
      clientRepository,
      approvalTokenRepository,
      pollTokenRepository,
      new InMemoryClientRegistrationRegisterTxn(
        clientRepository,
        approvalTokenRepository,
        pollTokenRepository,
      ),
      new InMemoryClientRegistrationDecisionTxn(
        approvalTokenRepository,
        clientRepository,
        userRepository,
      ),
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
        sendClientRegistrationRequestToOwner: async () => {},
        sendClientRegistrationApproved: async () => {},
        sendClientRegistrationRejected: async () => {},
        sendClientPasswordRecovery: async () => {},
      },
    );
    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = false;
    await userRepository.save(
      User.create({
        id: "owner-id",
        email: "owner@test.com",
        passwordHash: "hash",
        role: "user",
        status: "active",
      }),
    );
  });

  it("returns registrationPollToken on register and approved status after approve via poll token", async () => {
    const registered = await service.register({
      ownerEmail: "owner@test.com",
      email: "client@test.com",
      password: "ClientPwd1",
      name: "Client",
      lastName: "Audit",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value.registrationPollToken).toBeDefined();

    const approveToken = registered.value.approvalToken;
    expect(approveToken).toBeDefined();
    const approved = await service.approveRegistration(approveToken!);
    expect(approved.ok).toBe(true);

    const status = await service.getRegistrationStatus(registered.value.registrationPollToken!);
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.status).toBe("approved");
    }
  });

  it("resends approval for pending client with expired token via retry", async () => {
    const client = Client.create({
      id: "pending-expired-client",
      userId: "owner-id",
      email: "pending-expired@test.com",
      passwordHash: "hashed:ClientPwd1",
      name: "Pending",
      lastName: "Expired",
      status: "pending",
    });
    await clientRepository.save(client);
    await approvalTokenRepository.save({
      id: "expired-approval-token",
      clientId: client.id,
      createdAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await pollTokenRepository.save({
      id: "poll-token-pending-expired",
      clientId: client.id,
      createdAt: new Date(),
    });

    const retried = await service.retryClientRegistration({
      ownerEmail: "owner@test.com",
      email: client.email,
      password: "ClientPwd1",
    });
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.value.retried).toBe(true);

    const status = await service.getRegistrationStatus("poll-token-pending-expired");
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.status).toBe("pending");
  });

  it("returns unknown for invalid poll token (anti-enumeration)", async () => {
    const status = await service.getRegistrationStatus("missing-poll-token-0123456789abcdef");
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.status).toBe("unknown");
  });

  it("returns duplicate generic response when email already exists", async () => {
    await clientRepository.save(
      Client.create({
        id: "existing-client",
        userId: "owner-id",
        email: "existing@test.com",
        passwordHash: "hash",
        name: "Existing",
        lastName: "Client",
        status: "active",
      }),
    );
    const result = await service.register({
      ownerEmail: "owner@test.com",
      email: "existing@test.com",
      password: "ClientPwd1",
      name: "Dup",
      lastName: "Client",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.duplicate).toBe(true);
      expect(result.value.client).toBeUndefined();
    }
  });

  it("rejects public approve when owner is inactive", async () => {
    await userRepository.save(
      User.create({
        id: "owner-id",
        email: "owner@test.com",
        passwordHash: "hash",
        role: "user",
        status: "blocked",
      }),
    );
    const client = Client.create({
      id: "pending-owner-inactive",
      userId: "owner-id",
      email: "inactive-owner-client@test.com",
      passwordHash: "hash",
      name: "Pending",
      lastName: "OwnerInactive",
      status: "pending",
    });
    await clientRepository.save(client);
    await approvalTokenRepository.save({
      id: "owner-inactive-token",
      clientId: client.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.approveRegistration("owner-inactive-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_REQUEST");
    }
  });

  it("restores previous approval token when pending+expired retry email fails", async () => {
    const client = Client.create({
      id: "pending-email-fail",
      userId: "owner-id",
      email: "pending-email-fail@test.com",
      passwordHash: "hashed:ClientPwd1",
      name: "Pending",
      lastName: "EmailFail",
      status: "pending",
    });
    await clientRepository.save(client);
    const expiredToken = {
      id: "expired-before-retry",
      clientId: client.id,
      createdAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 1_000),
    };
    await approvalTokenRepository.save(expiredToken);

    const failingEmailService = new ClientRegistrationService(
      clientRepository,
      approvalTokenRepository,
      pollTokenRepository,
      new InMemoryClientRegistrationRegisterTxn(
        clientRepository,
        approvalTokenRepository,
        pollTokenRepository,
      ),
      new InMemoryClientRegistrationDecisionTxn(
        approvalTokenRepository,
        clientRepository,
        userRepository,
      ),
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
        sendClientRegistrationRequestToOwner: async () => {
          throw new Error("smtp down");
        },
        sendClientRegistrationApproved: async () => {},
        sendClientRegistrationRejected: async () => {},
        sendClientPasswordRecovery: async () => {},
      },
    );

    const retried = await failingEmailService.retryClientRegistration({
      ownerEmail: "owner@test.com",
      email: client.email,
      password: "ClientPwd1",
    });
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.value.retried).toBe(false);

    const restored = await approvalTokenRepository.findById(expiredToken.id);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe(expiredToken.id);

    const savedClient = await clientRepository.findById(client.id);
    expect(savedClient?.status).toBe("pending");
  });

  it("returns SERVICE_UNAVAILABLE when approve decision txn fails", async () => {
    const throwingTxn = {
      approve: async () => {
        throw new Error("db unavailable");
      },
      reject: async () => ({ status: "not_found" as const }),
      approveByClientId: async () => ({ status: "not_found" as const }),
      rejectByClientId: async () => ({ status: "not_found" as const }),
    };
    const failingService = new ClientRegistrationService(
      clientRepository,
      approvalTokenRepository,
      pollTokenRepository,
      new InMemoryClientRegistrationRegisterTxn(
        clientRepository,
        approvalTokenRepository,
        pollTokenRepository,
      ),
      throwingTxn,
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
        sendClientRegistrationRequestToOwner: async () => {},
        sendClientRegistrationApproved: async () => {},
        sendClientRegistrationRejected: async () => {},
        sendClientPasswordRecovery: async () => {},
      },
    );

    const result = await failingService.approveRegistration("any-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SERVICE_UNAVAILABLE");
      expect(result.error.statusCode).toBe(503);
    }
  });

  it("approves pending client by owner when public approval token is expired", async () => {
    const client = Client.create({
      id: "owner-approve-expired-token",
      userId: "owner-id",
      email: "owner-approve-expired@test.com",
      passwordHash: "hashed:ClientPwd1",
      name: "Owner",
      lastName: "ExpiredToken",
      status: "pending",
    });
    await clientRepository.save(client);
    await approvalTokenRepository.save({
      id: "expired-public-token",
      clientId: client.id,
      createdAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 1_000),
    });

    const approved = await service.approveByOwner("owner-id", client.id);
    expect(approved.ok).toBe(true);

    const saved = await clientRepository.findById(client.id);
    expect(saved?.status).toBe("active");
  });

  it("approves and rejects by authenticated owner", async () => {
    const registered = await service.register({
      ownerEmail: "owner@test.com",
      email: "owner-flow@test.com",
      password: "ClientPwd1",
      name: "Owner",
      lastName: "Flow",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok || !registered.value.client) return;

    const approved = await service.approveByOwner("owner-id", registered.value.client.id);
    expect(approved.ok).toBe(true);

    const registeredReject = await service.register({
      ownerEmail: "owner@test.com",
      email: "owner-reject@test.com",
      password: "ClientPwd1",
      name: "Owner",
      lastName: "Reject",
    });
    expect(registeredReject.ok).toBe(true);
    if (!registeredReject.ok || !registeredReject.value.client) return;

    const rejected = await service.rejectByOwner(
      "owner-id",
      registeredReject.value.client.id,
      "No",
    );
    expect(rejected.ok).toBe(true);
  });
});
