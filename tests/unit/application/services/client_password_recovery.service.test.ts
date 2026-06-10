import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClientPasswordRecoveryService } from "../../../../src/application/services/client_password_recovery.service";
import { Client } from "../../../../src/domain/entities/client.entity";
import type { IEmailSender } from "../../../../src/domain/ports/email_sender.port";
import { InMemoryClientPasswordRecoveryResetTxn } from "../../../../src/infrastructure/persistence/in_memory_client_password_recovery_reset_txn";
import { InMemoryClientPasswordRecoveryTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_password_recovery_token.repository";
import { InMemoryClientRefreshTokenRepository } from "../../../../src/infrastructure/repositories/in_memory_client_refresh_token.repository";
import { InMemoryClientRepository } from "../../../../src/infrastructure/repositories/in_memory_client.repository";
import {
  getClientPasswordRecoveryMetricsSnapshot,
  resetClientPasswordRecoveryMetrics,
} from "../../../../src/shared/metrics/client_password_recovery.metrics";

class FakePasswordHasher {
  async hash(plain: string): Promise<string> {
    return `hashed:${plain}`;
  }

  async compare(plain: string, hashedValue: string): Promise<boolean> {
    return hashedValue === `hashed:${plain}`;
  }
}

const createClient = (overrides?: Partial<Client>): Client =>
  Client.create({
    id: "client-id",
    userId: "owner-id",
    email: "client@test.com",
    passwordHash: "hashed:ClientPwd1",
    name: "Client",
    lastName: "Test",
    status: "active",
    ...overrides,
  });

describe("ClientPasswordRecoveryService", () => {
  let clientRepository: InMemoryClientRepository;
  let tokenRepository: InMemoryClientPasswordRecoveryTokenRepository;
  let refreshTokenRepository: InMemoryClientRefreshTokenRepository;
  let emailSender: IEmailSender;
  let service: ClientPasswordRecoveryService;

  beforeEach(() => {
    resetClientPasswordRecoveryMetrics();
    clientRepository = new InMemoryClientRepository();
    tokenRepository = new InMemoryClientPasswordRecoveryTokenRepository();
    refreshTokenRepository = new InMemoryClientRefreshTokenRepository();
    emailSender = {
      sendClientPasswordRecovery: vi.fn().mockResolvedValue(undefined),
    } as unknown as IEmailSender;
    service = new ClientPasswordRecoveryService(
      clientRepository,
      tokenRepository,
      new InMemoryClientPasswordRecoveryResetTxn(
        tokenRepository,
        clientRepository,
        refreshTokenRepository,
      ),
      new FakePasswordHasher(),
      emailSender,
    );
  });

  it("rolls back recovery token when email delivery fails", async () => {
    const client = createClient();
    await clientRepository.save(client);
    const deleteSpy = vi.spyOn(tokenRepository, "deleteById");
    vi.mocked(emailSender.sendClientPasswordRecovery).mockRejectedValueOnce(new Error("smtp down"));

    const result = await service.requestPasswordRecovery(client.email);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SERVICE_UNAVAILABLE");
    }
    expect(deleteSpy).toHaveBeenCalled();
  });

  it("increments cleanup metric when email and token rollback both fail", async () => {
    const client = createClient();
    await clientRepository.save(client);
    vi.mocked(emailSender.sendClientPasswordRecovery).mockRejectedValueOnce(new Error("smtp down"));
    vi.spyOn(tokenRepository, "deleteById").mockRejectedValueOnce(new Error("db down"));

    const result = await service.requestPasswordRecovery(client.email);

    expect(result.ok).toBe(false);
    expect(getClientPasswordRecoveryMetricsSnapshot().emailCleanupFailedTotal).toBe(1);
  });

  it("returns unknown status for missing recovery token", async () => {
    const status = await service.getPasswordRecoveryStatus("missing-recovery-token-012345678901234567");
    expect(status).toEqual({ ok: true, value: { status: "unknown" } });
  });

  it("returns unknown and deletes token when client is blocked", async () => {
    const client = createClient({ status: "blocked" });
    await clientRepository.save(client);
    const tokenId = "blocked-client-recovery-token-012345678901234567890";
    await tokenRepository.save({
      id: tokenId,
      clientId: client.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const status = await service.getPasswordRecoveryStatus(tokenId);

    expect(status).toEqual({ ok: true, value: { status: "unknown" } });
    expect(await tokenRepository.findById(tokenId)).toBeNull();
  });

  it("deletes expired token on status poll", async () => {
    const client = createClient();
    await clientRepository.save(client);
    const tokenId = "expired-poll-recovery-token-0123456789012345678901";
    await tokenRepository.save({
      id: tokenId,
      clientId: client.id,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });

    const status = await service.getPasswordRecoveryStatus(tokenId);

    expect(status).toEqual({ ok: true, value: { status: "expired" } });
    expect(await tokenRepository.findById(tokenId)).toBeNull();
  });

  it("rejects reset when new password matches the current password", async () => {
    const client = createClient();
    await clientRepository.save(client);
    const tokenId = "same-password-recovery-token-012345678901234567890";
    await tokenRepository.save({
      id: tokenId,
      clientId: client.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.resetPasswordByRecoveryToken(tokenId, "ClientPwd1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_REQUEST");
    }
  });

  it("cleans up orphan recovery token when client no longer exists", async () => {
    await tokenRepository.save({
      id: "orphan-recovery-token-01234567890123456789012",
      clientId: "missing-client-id",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const status = await service.getPasswordRecoveryStatus(
      "orphan-recovery-token-01234567890123456789012",
    );
    expect(status).toEqual({ ok: true, value: { status: "unknown" } });
    expect(
      await tokenRepository.findById("orphan-recovery-token-01234567890123456789012"),
    ).toBeNull();
  });

  it("invalidates the previous token when a second recovery is requested", async () => {
    const client = createClient();
    await clientRepository.save(client);

    await service.requestPasswordRecovery(client.email);
    const firstToken = vi.mocked(emailSender.sendClientPasswordRecovery).mock.calls[0]?.[0]
      ?.recoveryToken;
    expect(typeof firstToken).toBe("string");

    await service.requestPasswordRecovery(client.email);
    expect(await tokenRepository.findById(firstToken!)).toBeNull();
  });

  it("allows only one concurrent reset to succeed for the same token", async () => {
    const client = createClient();
    await clientRepository.save(client);
    const tokenId = "active-reset-token-012345678901234567890123456";
    await tokenRepository.save({
      id: tokenId,
      clientId: client.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [first, second] = await Promise.all([
      service.resetPasswordByRecoveryToken(tokenId, "NewPwd1"),
      service.resetPasswordByRecoveryToken(tokenId, "NewPwd2"),
    ]);

    const successes = [first, second].filter((result) => result.ok);
    const failures = [first, second].filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(await tokenRepository.findById(tokenId)).toBeNull();
  });
});
