import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/application/services/registration_email_outbox.service", () => ({
  enqueueClientRegistrationApprovalEmail: vi.fn(),
}));

import { enqueueClientRegistrationApprovalEmail } from "../../../../src/application/services/registration_email_outbox.service";
import { ClientAuthService } from "../../../../src/application/services/client_auth.service";
import { registerConsumerSocketControlHandler } from "../../../../src/application/services/consumer_socket_control_sink";
import { Client } from "../../../../src/domain/entities/client.entity";
import { ClientRefreshToken } from "../../../../src/domain/entities/client_refresh_token.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import type { IEmailSender } from "../../../../src/domain/ports/email_sender.port";
import type { IFileStorage } from "../../../../src/domain/ports/file_storage.port";
import type {
  ClientRegistrationApprovalReviewSummaryRecord,
  ClientRegistrationApprovalToken,
  IClientRegistrationApprovalTokenRepository,
} from "../../../../src/domain/repositories/client_registration_approval_token.repository.interface";
import type { ClientActiveSnapshot } from "../../../../src/domain/repositories/client.repository.interface";
import { InMemoryClientPasswordRecoveryTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_password_recovery_token.repository";
import { InMemoryClientRefreshTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_refresh_token.repository";
import { InMemoryClientRepository } from "../../../../src/infrastructure/repositories/in_memory_client.repository";
import { InMemoryUserRepository } from "../../../../src/infrastructure/repositories/in_memory_user.repository";
import { InMemoryClientRegistrationDecisionTxn } from "../../../../src/infrastructure/persistence/in_memory_client_registration_decision_txn";
import { env } from "../../../../src/shared/config/env";
import { signRefreshToken } from "../../../../src/shared/utils/jwt";

class FakePasswordHasher {
  async hash(plain: string): Promise<string> {
    return `hashed:${plain}`;
  }

  async compare(plain: string, hashedValue: string): Promise<boolean> {
    return hashedValue === `hashed:${plain}`;
  }
}

class TestClientRepository extends InMemoryClientRepository {
  snapshotLookups = 0;
  failOnDelete = false;

  override async findActiveSnapshotById(id: string): Promise<ClientActiveSnapshot | null> {
    this.snapshotLookups += 1;
    return super.findActiveSnapshotById(id);
  }

  override async deleteById(id: string): Promise<void> {
    if (this.failOnDelete) {
      throw new Error("client delete failed");
    }
    await super.deleteById(id);
  }
}

class TestClientRegistrationApprovalTokenRepository implements IClientRegistrationApprovalTokenRepository {
  private readonly store = new Map<string, ClientRegistrationApprovalToken>();
  private readonly tokenIdByClientId = new Map<string, string>();
  private readonly summaries = new Map<string, ClientRegistrationApprovalReviewSummaryRecord>();
  failOnSave = false;
  failOnDelete = false;

  async save(token: ClientRegistrationApprovalToken): Promise<void> {
    if (this.failOnSave) {
      throw new Error("token persistence failed");
    }
    const previousId = this.tokenIdByClientId.get(token.clientId);
    if (previousId) {
      this.store.delete(previousId);
    }
    this.store.set(token.id, token);
    this.tokenIdByClientId.set(token.clientId, token.id);
  }

  async replaceForClientRetry(
    _client: Client,
    token: ClientRegistrationApprovalToken,
  ): Promise<void> {
    await this.save(token);
  }

  async findById(id: string): Promise<ClientRegistrationApprovalToken | null> {
    return this.store.get(id) ?? null;
  }

  async findReviewSummaryById(
    id: string,
  ): Promise<ClientRegistrationApprovalReviewSummaryRecord | null> {
    return this.summaries.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    if (this.failOnDelete) {
      throw new Error("token delete failed");
    }
    const token = this.store.get(id);
    if (token) {
      this.tokenIdByClientId.delete(token.clientId);
    }
    this.store.delete(id);
    this.summaries.delete(id);
  }

  setReviewSummary(id: string, summary: ClientRegistrationApprovalReviewSummaryRecord): void {
    this.summaries.set(id, summary);
  }

  count(): number {
    return this.store.size;
  }
}

class TestFileStorage implements IFileStorage {
  deleted: string[] = [];
  failOnSave: unknown;
  nextSave = {
    url: "http://test.local/uploads/client-thumbnails/fresh.webp",
    storageKey: "client-thumbnails/fresh.webp",
  };

  async saveClientThumbnail(): Promise<{ url: string; storageKey: string }> {
    if (this.failOnSave !== undefined) {
      throw this.failOnSave;
    }
    return this.nextSave;
  }

  async delete(storageKey: string): Promise<void> {
    this.deleted.push(storageKey);
  }
}

type MockEmailSender = {
  [K in keyof IEmailSender]: ReturnType<typeof vi.fn>;
};

const createEmailSender = (): MockEmailSender => {
  const sender = {
    sendAdminApprovalRequest: vi.fn().mockResolvedValue(undefined),
    sendUserPendingRegistration: vi.fn().mockResolvedValue(undefined),
    sendUserApproved: vi.fn().mockResolvedValue(undefined),
    sendUserRejected: vi.fn().mockResolvedValue(undefined),
    sendClientAccessRequestToOwner: vi.fn().mockResolvedValue(undefined),
    sendClientAccessApproved: vi.fn().mockResolvedValue(undefined),
    sendClientAccessRejected: vi.fn().mockResolvedValue(undefined),
    sendClientRegistrationRequestToOwner: vi.fn().mockResolvedValue(undefined),
    sendClientRegistrationApproved: vi.fn().mockResolvedValue(undefined),
    sendClientRegistrationRejected: vi.fn().mockResolvedValue(undefined),
    sendClientPasswordRecovery: vi.fn().mockResolvedValue(undefined),
  } satisfies MockEmailSender;

  return sender;
};

type ClientCreateInput = Parameters<typeof Client.create>[0];

const createClient = (overrides?: Partial<ClientCreateInput>): Client =>
  Client.create({
    id: overrides?.id ?? "client-id",
    userId: overrides?.userId ?? "owner-id",
    email: overrides?.email ?? "client@test.com",
    passwordHash: overrides?.passwordHash ?? "hashed:ClientPwd1",
    name: overrides?.name ?? "Client",
    lastName: overrides?.lastName ?? "Tester",
    status: overrides?.status ?? "active",
    ...(overrides?.mobile !== undefined ? { mobile: overrides.mobile } : {}),
    ...(overrides?.thumbnailUrl !== undefined ? { thumbnailUrl: overrides.thumbnailUrl } : {}),
    ...(overrides?.createdAt !== undefined ? { createdAt: overrides.createdAt } : {}),
    ...(overrides?.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides?.credentialsUpdatedAt !== undefined
      ? { credentialsUpdatedAt: overrides.credentialsUpdatedAt }
      : {}),
  });

describe("ClientAuthService account and approval paths", () => {
  let userRepository: InMemoryUserRepository;
  let clientRepository: TestClientRepository;
  let refreshTokenRepository: InMemoryClientRefreshTokenRepository;
  let passwordRecoveryTokenRepository: InMemoryClientPasswordRecoveryTokenRepository;
  let registrationApprovalTokenRepository: TestClientRegistrationApprovalTokenRepository;
  let emailSender: ReturnType<typeof createEmailSender>;
  let fileStorage: TestFileStorage;
  let service: ClientAuthService;

  beforeEach(async () => {
    vi.clearAllMocks();
    registerConsumerSocketControlHandler(undefined);
    userRepository = new InMemoryUserRepository();
    clientRepository = new TestClientRepository();
    refreshTokenRepository = new InMemoryClientRefreshTokenRepository();
    passwordRecoveryTokenRepository = new InMemoryClientPasswordRecoveryTokenRepository();
    registrationApprovalTokenRepository = new TestClientRegistrationApprovalTokenRepository();
    emailSender = createEmailSender();
    fileStorage = new TestFileStorage();
    service = new ClientAuthService(
      clientRepository,
      refreshTokenRepository,
      passwordRecoveryTokenRepository,
      registrationApprovalTokenRepository,
      new InMemoryClientRegistrationDecisionTxn(
        registrationApprovalTokenRepository,
        clientRepository,
      ),
      userRepository,
      new FakePasswordHasher(),
      emailSender,
      fileStorage,
    );

    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = false;
    (env as { registrationEmailMaxRetries: number }).registrationEmailMaxRetries = 1;
    (env as { registrationEmailRetryDelayMs: number }).registrationEmailRetryDelayMs = 0;
    (env as { principalSnapshotCacheTtlMs: number }).principalSnapshotCacheTtlMs = 60_000;

    await userRepository.save(
      User.create({
        id: "owner-id",
        email: "owner@test.com",
        passwordHash: "owner-hash",
        role: "user",
        status: "active",
      }),
    );
  });

  it("uses queued registration email path when async outbox accepts the request", async () => {
    vi.mocked(enqueueClientRegistrationApprovalEmail).mockResolvedValue(true);
    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = true;

    const result = await service.register({
      ownerEmail: "owner@test.com",
      email: "queued@test.com",
      password: "ClientPwd1",
      name: "Queued",
      lastName: "Client",
      mobile: "+5511999999999",
    });

    expect(result.ok).toBe(true);
    expect(emailSender.sendClientRegistrationRequestToOwner).not.toHaveBeenCalled();
  });

  it("surfaces duplicate client registration as conflict", async () => {
    await clientRepository.save(createClient());

    const result = await service.register({
      ownerEmail: "owner@test.com",
      email: "client@test.com",
      password: "ClientPwd1",
      name: "Dup",
      lastName: "Client",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("resolves owner email case-insensitively for register and retry", async () => {
    const reg = await service.register({
      ownerEmail: "OWNER@TEST.COM",
      email: `case-owner-${Date.now()}@test.com`,
      password: "ClientPwd1",
      name: "Case",
      lastName: "Owner",
    });
    expect(reg.ok).toBe(true);

    const rejectedClient = createClient({
      id: "case-retry-client",
      email: `case-retry-${Date.now()}@test.com`,
      userId: "owner-id",
      status: "rejected",
    });
    await clientRepository.save(rejectedClient);
    const retry = await service.retryRejectedRegistration({
      ownerEmail: "Owner@Test.Com",
      email: rejectedClient.email,
      password: "ClientPwd1",
    });
    expect(retry).toEqual({ ok: true, value: { retried: true } });
  });

  it("rolls back retry when re-dispatching the approval email fails", async () => {
    const client = createClient({
      id: "retry-client-id",
      email: "retry-email-fail@test.com",
      status: "rejected",
    });
    await clientRepository.save(client);
    emailSender.sendClientRegistrationRequestToOwner.mockRejectedValue(new Error("smtp offline"));

    const result = await service.retryRejectedRegistration({
      ownerEmail: "owner@test.com",
      email: client.email,
      password: "ClientPwd1",
    });

    expect(result).toEqual({ ok: true, value: { retried: false } });
    expect((await clientRepository.findById(client.id))?.status).toBe("rejected");
    expect(registrationApprovalTokenRepository.count()).toBe(0);
  });

  it("builds registration review summary from repository summary and falls back to null when token is missing", async () => {
    registrationApprovalTokenRepository.setReviewSummary("summary-token", {
      ownerEmail: "owner@test.com",
      clientEmail: "summary@test.com",
      clientName: "Summary Client",
      clientStatus: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const summary = await service.getRegistrationReviewSummary("summary-token");
    const missing = await service.getRegistrationReviewSummary("missing-summary-token");

    expect(summary).toEqual({
      ownerEmail: "owner@test.com",
      clientEmail: "summary@test.com",
      clientName: "Summary Client",
      clientStatus: "pending",
      tokenStatus: "pending",
    });
    expect(missing).toBeNull();
  });

  it("returns null registration review summary when token fallback cannot resolve client or owner", async () => {
    await registrationApprovalTokenRepository.save({
      id: "orphan-token",
      clientId: "missing-client-id",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await service.getRegistrationReviewSummary("orphan-token")).toBeNull();

    const missingOwnerClient = createClient({
      id: "missing-owner-client-id",
      userId: "missing-owner-id",
      email: "missing-owner@test.com",
      status: "pending",
    });
    await clientRepository.save(missingOwnerClient);
    await registrationApprovalTokenRepository.save({
      id: "missing-owner-token",
      clientId: missingOwnerClient.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await service.getRegistrationReviewSummary("missing-owner-token")).toBeNull();
  });

  it("filters and paginates managed clients for an active owner", async () => {
    await clientRepository.save(createClient({ id: "c1", email: "alpha@test.com", name: "Alpha" }));
    await clientRepository.save(
      createClient({
        id: "c2",
        email: "beta@test.com",
        name: "Beta",
        status: "blocked",
      }),
    );
    await clientRepository.save(
      createClient({
        id: "c3",
        email: "gamma@test.com",
        name: "Gamma",
        status: "rejected",
      }),
    );

    const result = await service.listManagedClientsPage("owner-id", {
      status: "blocked",
      search: "beta",
      page: 1,
      pageSize: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        total: 1,
        page: 1,
        pageSize: 1,
      },
    });
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.items[0]?.id).toBe("c2");
    }
  });

  it("guards managed client operations when owner or target is invalid", async () => {
    const blockedOwner = User.create({
      id: "blocked-owner-id",
      email: "blocked-owner@test.com",
      passwordHash: "owner-hash",
      role: "user",
      status: "blocked",
    });
    await userRepository.save(blockedOwner);

    expect(await service.listManagedClientsPage("missing-owner-id")).toMatchObject({
      ok: false,
    });
    expect(await service.findManagedClient("blocked-owner-id", "client-id")).toMatchObject({
      ok: false,
    });
    expect(
      await service.setManagedClientStatus("owner-id", "missing-client-id", "active"),
    ).toMatchObject({
      ok: false,
    });
  });

  it("blocks and unblocks managed clients with session revocation and socket disconnect", async () => {
    const disconnectPrincipal = vi.fn().mockResolvedValue(undefined);
    registerConsumerSocketControlHandler({
      disconnectPrincipal,
      revokeClientAccess: vi.fn().mockResolvedValue(undefined),
      grantClientAccess: vi.fn(),
    });

    const activeClient = createClient({ id: "managed-client-id", email: "managed@test.com" });
    await clientRepository.save(activeClient);

    const loginResult = await service.login({
      email: activeClient.email,
      password: "ClientPwd1",
    });
    expect(loginResult.ok).toBe(true);
    if (!loginResult.ok) {
      return;
    }

    await refreshTokenRepository.save(
      ClientRefreshToken.create({
        id: "seed-refresh-id",
        clientId: activeClient.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const blocked = await service.setManagedClientStatus("owner-id", activeClient.id, "blocked");
    expect(blocked.ok).toBe(true);
    expect((await clientRepository.findById(activeClient.id))?.status).toBe("blocked");
    expect(disconnectPrincipal).toHaveBeenCalledTimes(1);

    const blockedRefreshPayload = signRefreshToken({
      sub: activeClient.id,
      jti: "blocked-refresh-id",
      principal_type: "client",
      tokenType: "refresh",
    });
    await refreshTokenRepository.save(
      ClientRefreshToken.create({
        id: "blocked-refresh-id",
        clientId: activeClient.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const refreshWhileBlocked = await service.refresh(blockedRefreshPayload);
    expect(refreshWhileBlocked.ok).toBe(false);
    if (!refreshWhileBlocked.ok) {
      expect(refreshWhileBlocked.error.code).toBe("FORBIDDEN");
    }

    const unblocked = await service.setManagedClientStatus("owner-id", activeClient.id, "active");
    expect(unblocked.ok).toBe(true);
    expect((await clientRepository.findById(activeClient.id))?.status).toBe("active");
  });

  it("rejects invalid managed client transitions and no-op repeats", async () => {
    const pendingClient = createClient({
      id: "pending-client-id",
      email: "pending-managed@test.com",
      status: "pending",
    });
    const activeClient = createClient({
      id: "active-client-id",
      email: "active-managed@test.com",
      status: "active",
    });
    await clientRepository.save(pendingClient);
    await clientRepository.save(activeClient);

    const repeated = await service.setManagedClientStatus("owner-id", activeClient.id, "active");
    expect(repeated.ok).toBe(true);

    const invalidPending = await service.setManagedClientStatus(
      "owner-id",
      pendingClient.id,
      "blocked",
    );
    expect(invalidPending.ok).toBe(false);
    if (!invalidPending.ok) {
      expect(invalidPending.error.code).toBe("CONFLICT");
    }

    const invalidTargetStatus = await service.setManagedClientStatus(
      "owner-id",
      activeClient.id,
      "rejected",
    );
    expect(invalidTargetStatus.ok).toBe(false);
    if (!invalidTargetStatus.ok) {
      expect(invalidTargetStatus.error.code).toBe("BAD_REQUEST");
    }
  });

  it("rejects login, refresh and logout edge cases", async () => {
    const blockedClient = createClient({
      id: "blocked-login-client-id",
      email: "blocked-login@test.com",
      status: "blocked",
    });
    await clientRepository.save(blockedClient);

    const missingLogin = await service.login({ email: "missing@test.com", password: "ClientPwd1" });
    const blockedLogin = await service.login({
      email: blockedClient.email,
      password: "ClientPwd1",
    });
    const badPassword = await service.login({
      email: blockedClient.email,
      password: "WrongPwd1",
    });
    expect(missingLogin.ok).toBe(false);
    expect(blockedLogin.ok).toBe(false);
    expect(badPassword.ok).toBe(false);

    const invalidRefresh = await service.refresh("not-a-jwt");
    expect(invalidRefresh.ok).toBe(false);

    const wrongPrincipalToken = signRefreshToken({
      sub: "user-id",
      jti: "user-refresh-id",
      principal_type: "user",
      tokenType: "refresh",
    });
    const wrongPrincipalRefresh = await service.refresh(wrongPrincipalToken);
    expect(wrongPrincipalRefresh.ok).toBe(false);

    const logoutInvalid = await service.logout("not-a-jwt");
    const logoutWrongPrincipal = await service.logout(wrongPrincipalToken);
    expect(logoutInvalid).toEqual({ ok: true, value: undefined });
    expect(logoutWrongPrincipal).toEqual({ ok: true, value: undefined });
  });

  it("handles refresh and active client validation branches", async () => {
    const activeClient = createClient({
      id: "refresh-client-id",
      email: "refresh-client@test.com",
      credentialsUpdatedAt: new Date(1_700_000_000_000),
    });
    const rejectedClient = createClient({
      id: "rejected-client-id",
      email: "rejected-client@test.com",
      status: "rejected",
    });
    await clientRepository.save(activeClient);
    await clientRepository.save(rejectedClient);

    const missingRefreshToken = signRefreshToken({
      sub: "missing-client-id",
      jti: "missing-refresh-id",
      principal_type: "client",
      tokenType: "refresh",
    });
    await refreshTokenRepository.save(
      ClientRefreshToken.create({
        id: "missing-refresh-id",
        clientId: "missing-client-id",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const missingRefresh = await service.refresh(missingRefreshToken);
    expect(missingRefresh.ok).toBe(false);

    const rejectedRefreshToken = signRefreshToken({
      sub: rejectedClient.id,
      jti: "rejected-refresh-id",
      principal_type: "client",
      tokenType: "refresh",
    });
    await refreshTokenRepository.save(
      ClientRefreshToken.create({
        id: "rejected-refresh-id",
        clientId: rejectedClient.id,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const rejectedRefresh = await service.refresh(rejectedRefreshToken);
    expect(rejectedRefresh.ok).toBe(false);

    const missingClient = await service.getActiveClient("missing-client-id");
    const rejectedActive = await service.getActiveClient(rejectedClient.id);
    const staleToken = await service.getActiveClient(
      activeClient.id,
      undefined,
      activeClient.credentialsUpdatedAt.getTime() + 1,
    );
    const usingPreloaded = await service.getActiveClient(activeClient.id, activeClient);
    expect(missingClient.ok).toBe(false);
    expect(rejectedActive.ok).toBe(false);
    expect(staleToken.ok).toBe(false);
    expect(usingPreloaded).toMatchObject({ ok: true });
  });

  it("uses cached active client snapshots and rejects stale snapshot credentials", async () => {
    const activeClient = createClient({
      id: "snapshot-client-id",
      email: "snapshot@test.com",
      credentialsUpdatedAt: new Date(1_700_000_000_100),
    });
    const blockedClient = createClient({
      id: "snapshot-blocked-id",
      email: "snapshot-blocked@test.com",
      status: "blocked",
    });
    await clientRepository.save(activeClient);
    await clientRepository.save(blockedClient);

    const first = await service.getActiveClientSnapshot(
      activeClient.id,
      activeClient.credentialsUpdatedAt.getTime(),
    );
    const second = await service.getActiveClientSnapshot(
      activeClient.id,
      activeClient.credentialsUpdatedAt.getTime(),
    );
    const missing = await service.getActiveClientSnapshot("missing-snapshot-id");
    const blocked = await service.getActiveClientSnapshot(blockedClient.id);
    const stale = await service.getActiveClientSnapshot(
      activeClient.id,
      activeClient.credentialsUpdatedAt.getTime() + 10,
    );

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(clientRepository.snapshotLookups).toBe(4);
    expect(missing.ok).toBe(false);
    expect(blocked.ok).toBe(false);
    expect(stale.ok).toBe(false);

    service.invalidateSnapshotCache(activeClient.id);
    await service.getActiveClientSnapshot(
      activeClient.id,
      activeClient.credentialsUpdatedAt.getTime(),
    );
    expect(clientRepository.snapshotLookups).toBe(5);
  });

  it("updates client profile branches including no-op and thumbnail removal", async () => {
    const client = createClient({
      id: "profile-client-id",
      email: "profile@test.com",
      mobile: "+5511000000000",
      thumbnailUrl: `${env.uploadsPublicBaseUrl}/client-thumbnails/old.webp`,
    });
    await clientRepository.save(client);

    const noChanges = await service.updateMyProfile(client.id, {}, client);
    expect(noChanges).toMatchObject({ ok: true });

    const removedThumbnail = await service.updateMyProfile(
      client.id,
      {
        name: "Updated",
        mobile: null,
        thumbnailUrl: null,
      },
      client,
    );
    expect(removedThumbnail).toMatchObject({ ok: true });
    expect(fileStorage.deleted).toContain("client-thumbnails/old.webp");

    const blocked = createClient({
      id: "profile-blocked-id",
      email: "profile-blocked@test.com",
      status: "blocked",
    });
    await clientRepository.save(blocked);
    const blockedUpdate = await service.updateMyProfile(blocked.id, { name: "Nope" });
    expect(blockedUpdate.ok).toBe(false);
  });

  it("updates thumbnails and reports invalid thumbnail uploads", async () => {
    const client = createClient({
      id: "thumb-client-id",
      email: "thumb@test.com",
      thumbnailUrl: `${env.uploadsPublicBaseUrl}/client-thumbnails/previous.webp`,
    });
    await clientRepository.save(client);

    const success = await service.updateThumbnail(
      client.id,
      {
        buffer: Buffer.from("image"),
        mimeType: "image/png",
      },
      client,
    );
    expect(success).toMatchObject({ ok: true });
    expect(fileStorage.deleted).toContain("client-thumbnails/previous.webp");

    fileStorage.failOnSave = new Error("invalid image");
    const invalid = await service.updateThumbnail(client.id, {
      buffer: Buffer.from("bad"),
      mimeType: "image/png",
    });
    expect(invalid.ok).toBe(false);

    const blocked = createClient({
      id: "thumb-blocked-id",
      email: "thumb-blocked@test.com",
      status: "blocked",
    });
    await clientRepository.save(blocked);
    const blockedUpdate = await service.updateThumbnail(blocked.id, {
      buffer: Buffer.from("blocked"),
      mimeType: "image/png",
    });
    expect(blockedUpdate.ok).toBe(false);
  });

  it("changes passwords and handles missing or invalid credentials", async () => {
    const client = createClient({
      id: "password-client-id",
      email: "password@test.com",
    });
    await clientRepository.save(client);
    await passwordRecoveryTokenRepository.save({
      id: "seed-recovery-id",
      clientId: client.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const missing = await service.changePassword({
      clientId: "missing-password-client-id",
      currentPassword: "ClientPwd1",
      newPassword: "NewPass1",
    });
    const wrongPassword = await service.changePassword({
      clientId: client.id,
      currentPassword: "WrongPwd1",
      newPassword: "NewPass1",
    });
    const success = await service.changePassword({
      clientId: client.id,
      currentPassword: "ClientPwd1",
      newPassword: "NewPass1",
    });

    expect(missing.ok).toBe(false);
    expect(wrongPassword.ok).toBe(false);
    expect(success).toEqual({ ok: true, value: undefined });
    expect(await passwordRecoveryTokenRepository.findById("seed-recovery-id")).toBeNull();
  });

  it("covers registration approval and rejection edge cases", async () => {
    const pending = createClient({
      id: "pending-approval-client-id",
      email: "pending-approval@test.com",
      status: "pending",
    });
    const active = createClient({
      id: "active-approval-client-id",
      email: "active-approval@test.com",
      status: "active",
    });
    await clientRepository.save(pending);
    await clientRepository.save(active);

    const missingApprove = await service.approveRegistration("missing-approve-token");
    expect(missingApprove.ok).toBe(false);

    await registrationApprovalTokenRepository.save({
      id: "orphan-approve-token",
      clientId: "missing-client-id",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const orphanApprove = await service.approveRegistration("orphan-approve-token");
    expect(orphanApprove.ok).toBe(false);

    await registrationApprovalTokenRepository.save({
      id: "expired-approve-token",
      clientId: pending.id,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    const expiredApprove = await service.approveRegistration("expired-approve-token");
    expect(expiredApprove.ok).toBe(false);

    await registrationApprovalTokenRepository.save({
      id: "already-approved-token",
      clientId: active.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conflictApprove = await service.approveRegistration("already-approved-token");
    expect(conflictApprove.ok).toBe(false);

    const missingReject = await service.rejectRegistration("missing-reject-token");
    expect(missingReject.ok).toBe(false);

    await registrationApprovalTokenRepository.save({
      id: "orphan-reject-token",
      clientId: "missing-client-id",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const orphanReject = await service.rejectRegistration("orphan-reject-token");
    expect(orphanReject.ok).toBe(false);

    await registrationApprovalTokenRepository.save({
      id: "expired-reject-token",
      clientId: pending.id,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    const expiredReject = await service.rejectRegistration("expired-reject-token");
    expect(expiredReject.ok).toBe(false);

    await registrationApprovalTokenRepository.save({
      id: "already-rejected-token",
      clientId: active.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const conflictReject = await service.rejectRegistration("already-rejected-token");
    expect(conflictReject.ok).toBe(false);
  });

  it("handles registration status and password recovery branches", async () => {
    const pendingRegPollClient = createClient({
      id: "reg-poll-client-id",
      email: "reg-poll@test.com",
      status: "pending",
    });
    const client = createClient({
      id: "recovery-client-id",
      email: "recovery@test.com",
      status: "active",
    });
    const blockedClient = createClient({
      id: "blocked-recovery-client-id",
      email: "blocked-recovery@test.com",
      status: "blocked",
    });
    await clientRepository.save(pendingRegPollClient);
    await clientRepository.save(client);
    await clientRepository.save(blockedClient);

    const missingStatus = await service.getRegistrationStatus("missing-status-token");
    expect(missingStatus.ok).toBe(false);

    await registrationApprovalTokenRepository.save({
      id: "expired-status-token",
      clientId: pendingRegPollClient.id,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    const expiredStatus = await service.getRegistrationStatus("expired-status-token");
    expect(expiredStatus).toEqual({ ok: true, value: { status: "expired" } });

    const activeWithStaleToken = createClient({
      id: "stale-token-client",
      email: "stale-status@test.com",
      status: "active",
    });
    await clientRepository.save(activeWithStaleToken);
    await registrationApprovalTokenRepository.save({
      id: "stale-but-active-token",
      clientId: activeWithStaleToken.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const staleActiveStatus = await service.getRegistrationStatus("stale-but-active-token");
    expect(staleActiveStatus).toEqual({ ok: true, value: { status: "approved" } });

    const rejectedWithStaleToken = createClient({
      id: "rej-stale-client",
      email: "rej-stale@test.com",
      status: "rejected",
    });
    await clientRepository.save(rejectedWithStaleToken);
    await registrationApprovalTokenRepository.save({
      id: "stale-rejected-token",
      clientId: rejectedWithStaleToken.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const staleRejectedStatus = await service.getRegistrationStatus("stale-rejected-token");
    expect(staleRejectedStatus).toEqual({ ok: true, value: { status: "rejected" } });

    await registrationApprovalTokenRepository.save({
      id: "orphan-status-token",
      clientId: "missing-client-for-status",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const orphanStatusPoll = await service.getRegistrationStatus("orphan-status-token");
    expect(orphanStatusPoll.ok).toBe(false);
    expect(await registrationApprovalTokenRepository.findById("orphan-status-token")).toBeNull();

    const inactiveRecovery = await service.requestPasswordRecovery(blockedClient.email);
    expect(inactiveRecovery).toEqual({ ok: true, value: undefined });

    emailSender.sendClientPasswordRecovery.mockRejectedValue(new Error("mail down"));
    const activeRecovery = await service.requestPasswordRecovery(client.email);
    expect(activeRecovery).toEqual({ ok: true, value: undefined });

    const missingRecoveryStatus = await service.getPasswordRecoveryStatus("missing-recovery-token");
    expect(missingRecoveryStatus.ok).toBe(false);

    await passwordRecoveryTokenRepository.save({
      id: "expired-recovery-token",
      clientId: client.id,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    const expiredRecoveryStatus = await service.getPasswordRecoveryStatus("expired-recovery-token");
    expect(expiredRecoveryStatus).toEqual({ ok: true, value: { status: "expired" } });
  });

  it("resets passwords by recovery token across missing, expired and inactive branches", async () => {
    const activeClient = createClient({
      id: "reset-client-id",
      email: "reset@test.com",
    });
    const blockedClient = createClient({
      id: "reset-blocked-client-id",
      email: "reset-blocked@test.com",
      status: "blocked",
    });
    await clientRepository.save(activeClient);
    await clientRepository.save(blockedClient);

    const missing = await service.resetPasswordByRecoveryToken("missing-reset-token", "NewPwd1");
    expect(missing.ok).toBe(false);

    await passwordRecoveryTokenRepository.save({
      id: "expired-reset-token",
      clientId: activeClient.id,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    const expired = await service.resetPasswordByRecoveryToken("expired-reset-token", "NewPwd1");
    expect(expired.ok).toBe(false);
    expect(await passwordRecoveryTokenRepository.findById("expired-reset-token")).toBeNull();

    await passwordRecoveryTokenRepository.save({
      id: "missing-client-reset-token",
      clientId: "missing-client-id",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const missingClient = await service.resetPasswordByRecoveryToken(
      "missing-client-reset-token",
      "NewPwd1",
    );
    expect(missingClient.ok).toBe(false);

    await passwordRecoveryTokenRepository.save({
      id: "blocked-reset-token",
      clientId: blockedClient.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const blocked = await service.resetPasswordByRecoveryToken("blocked-reset-token", "NewPwd1");
    expect(blocked.ok).toBe(false);

    await passwordRecoveryTokenRepository.save({
      id: "active-reset-token",
      clientId: activeClient.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const success = await service.resetPasswordByRecoveryToken("active-reset-token", "NewPwd1");
    expect(success).toEqual({ ok: true, value: undefined });
  });

  it("returns me profile only for active clients", async () => {
    const activeClient = createClient({
      id: "me-active-client-id",
      email: "me-active@test.com",
    });
    const rejectedClient = createClient({
      id: "me-rejected-client-id",
      email: "me-rejected@test.com",
      status: "rejected",
    });
    await clientRepository.save(activeClient);
    await clientRepository.save(rejectedClient);

    const success = await service.getMeProfile(activeClient.id, activeClient);
    const rejected = await service.getMeProfile(rejectedClient.id);

    expect(success).toMatchObject({ ok: true });
    expect(rejected.ok).toBe(false);
  });

  it("best-effort cleanup keeps register failure surfacing even when rollback steps fail", async () => {
    clientRepository.failOnDelete = true;
    registrationApprovalTokenRepository.failOnDelete = true;
    emailSender.sendClientRegistrationRequestToOwner.mockRejectedValue(
      new Error("smtp hard failure"),
    );

    await expect(
      service.register({
        ownerEmail: "owner@test.com",
        email: "cleanup-fail@test.com",
        password: "ClientPwd1",
        name: "Cleanup",
        lastName: "Fail",
      }),
    ).rejects.toThrow("sendClientRegistrationRequestToOwner failed after 1 attempts");
  });
});
