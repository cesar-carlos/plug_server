import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../../../../src/application/services/auth.service";
import { RegistrationApprovalToken } from "../../../../src/domain/entities/registration_approval_token.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import { env } from "../../../../src/shared/config/env";
import { ok } from "../../../../src/shared/errors/result";

describe("AuthService registration email retry", () => {
  const registerExecute = vi.fn();
  const hash = vi.fn();
  const compare = vi.fn();
  const refreshSave = vi.fn();
  const assertAccess = vi.fn();
  const sendAdminApprovalRequest = vi.fn();
  const sendUserPendingRegistration = vi.fn();
  const sendUserApproved = vi.fn();
  const sendUserRejected = vi.fn();

  const buildService = (): AuthService =>
    new AuthService(
      { execute: registerExecute } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { hash, compare } as never,
      { save: refreshSave } as never,
      { assertAccess } as never,
      {
        sendAdminApprovalRequest,
        sendUserPendingRegistration,
        sendUserApproved,
        sendUserRejected,
      } as never,
      { findById: vi.fn(), findByEmail: vi.fn(), findByCelular: vi.fn(), save: vi.fn() } as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = false;
    (env as { registrationEmailMaxRetries: number }).registrationEmailMaxRetries = 3;
    (env as { registrationEmailRetryDelayMs: number }).registrationEmailRetryDelayMs = 0;

    hash.mockResolvedValue("hashed-password");
    compare.mockResolvedValue(false);
    refreshSave.mockResolvedValue(undefined);
    assertAccess.mockResolvedValue(ok(undefined));

    const user = User.create({
      id: "f7a5f000-7c03-4fca-8fca-c9cf216bb3f4",
      email: "retry-user@test.com",
      passwordHash: "hashed-password",
      role: "user",
      status: "pending",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const approvalToken = RegistrationApprovalToken.create({
      id: "opaque-token-retry-flow",
      userId: user.id,
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    registerExecute.mockResolvedValue(ok({ user, approvalToken }));
  });

  it("retries admin approval email before succeeding", async () => {
    sendAdminApprovalRequest
      .mockRejectedValueOnce(new Error("smtp temporary error 1"))
      .mockRejectedValueOnce(new Error("smtp temporary error 2"))
      .mockResolvedValueOnce(undefined);
    sendUserPendingRegistration.mockResolvedValue(undefined);

    const service = buildService();
    const result = await service.register({
      email: "retry-user@test.com",
      password: "Password1",
    });

    expect(result.ok).toBe(true);
    expect(sendAdminApprovalRequest).toHaveBeenCalledTimes(3);
    expect(sendUserPendingRegistration).toHaveBeenCalledTimes(1);
  });

  it("throws when admin email still fails after all retries in sync mode", async () => {
    sendAdminApprovalRequest.mockRejectedValue(new Error("smtp hard failure"));
    sendUserPendingRegistration.mockResolvedValue(undefined);

    const service = buildService();
    await expect(
      service.register({
        email: "retry-user@test.com",
        password: "Password1",
      }),
    ).rejects.toThrow("sendAdminApprovalRequest failed after 3 attempts");

    expect(sendAdminApprovalRequest).toHaveBeenCalledTimes(3);
    expect(sendUserPendingRegistration).not.toHaveBeenCalled();
  });
});
