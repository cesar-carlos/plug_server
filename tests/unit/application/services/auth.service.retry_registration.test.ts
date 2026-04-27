import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../../../../src/application/services/auth.service";
import { User } from "../../../../src/domain/entities/user.entity";
import { env } from "../../../../src/shared/config/env";

describe("AuthService retryRejectedRegistration", () => {
  const compare = vi.fn();
  const saveUser = vi.fn();
  const findUserByEmail = vi.fn();
  const saveApprovalToken = vi.fn();
  const replaceForUserRetry = vi.fn();
  const deleteApprovalTokensByUserId = vi.fn();
  const sendAdminApprovalRequest = vi.fn();
  const sendUserPendingRegistration = vi.fn();

  const rejectedUser = User.create({
    id: "7ec56d67-c938-4a6e-9db3-53db3fc1ee44",
    email: "retry-auth@test.com",
    passwordHash: "hashed-password",
    role: "user",
    status: "rejected",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  const buildService = (): AuthService =>
    new AuthService(
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      {
        save: saveApprovalToken,
        replaceForUserRetry,
        findById: vi.fn(),
        findReviewSummaryById: vi.fn(),
        deleteById: vi.fn(),
        deleteByUserId: deleteApprovalTokensByUserId,
      } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { hash: vi.fn(), compare } as never,
      { save: vi.fn() } as never,
      { assertAccess: vi.fn() } as never,
      {
        sendAdminApprovalRequest,
        sendUserPendingRegistration,
        sendUserApproved: vi.fn(),
        sendUserRejected: vi.fn(),
      } as never,
      {
        findById: vi.fn(),
        findByEmail: findUserByEmail,
        findByCelular: vi.fn(),
        findActiveSnapshotById: vi.fn(),
        save: saveUser,
      } as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = false;
    (env as { registrationEmailMaxRetries: number }).registrationEmailMaxRetries = 1;
    (env as { registrationEmailRetryDelayMs: number }).registrationEmailRetryDelayMs = 0;

    compare.mockResolvedValue(true);
    findUserByEmail.mockResolvedValue(rejectedUser);
    saveUser.mockResolvedValue(undefined);
    saveApprovalToken.mockResolvedValue(undefined);
    replaceForUserRetry.mockImplementation(async (_user: User, token: unknown) => {
      await deleteApprovalTokensByUserId(rejectedUser.id);
      await saveApprovalToken(token);
    });
    deleteApprovalTokensByUserId.mockResolvedValue(undefined);
    sendAdminApprovalRequest.mockResolvedValue(undefined);
    sendUserPendingRegistration.mockResolvedValue(undefined);
  });

  it("reopens a rejected registration and resends approval emails", async () => {
    const service = buildService();

    const result = await service.retryRejectedRegistration({
      email: rejectedUser.email,
      password: "Password1",
    });

    expect(result).toEqual({ ok: true, value: { retried: true } });
    expect(deleteApprovalTokensByUserId).toHaveBeenCalledWith(rejectedUser.id);
    expect(saveApprovalToken).toHaveBeenCalledTimes(1);
    expect(saveUser).toHaveBeenCalledTimes(1);
    expect(saveUser.mock.calls[0]?.[0].status).toBe("pending");
    expect(sendAdminApprovalRequest).toHaveBeenCalledTimes(1);
    expect(sendUserPendingRegistration).toHaveBeenCalledWith({ email: rejectedUser.email });
  });

  it("returns a generic false result when the password does not match", async () => {
    compare.mockResolvedValue(false);
    const service = buildService();

    const result = await service.retryRejectedRegistration({
      email: rejectedUser.email,
      password: "WrongPassword1",
    });

    expect(result).toEqual({ ok: true, value: { retried: false } });
    expect(saveApprovalToken).not.toHaveBeenCalled();
    expect(saveUser).not.toHaveBeenCalled();
  });

  it("rolls back when persisting the new approval token fails", async () => {
    saveApprovalToken.mockRejectedValue(new Error("token persistence failed"));
    const service = buildService();

    const result = await service.retryRejectedRegistration({
      email: rejectedUser.email,
      password: "Password1",
    });

    expect(result).toEqual({ ok: true, value: { retried: false } });
    expect(deleteApprovalTokensByUserId).toHaveBeenCalledTimes(2);
    expect(saveUser).toHaveBeenCalledTimes(1);
    expect(saveUser.mock.calls[0]?.[0].status).toBe("rejected");
    expect(sendAdminApprovalRequest).not.toHaveBeenCalled();
  });

  it("rolls back to rejected when email delivery fails after reopening", async () => {
    sendAdminApprovalRequest.mockRejectedValue(new Error("smtp unavailable"));
    const service = buildService();

    const result = await service.retryRejectedRegistration({
      email: rejectedUser.email,
      password: "Password1",
    });

    expect(result).toEqual({ ok: true, value: { retried: false } });
    expect(saveUser).toHaveBeenCalledTimes(2);
    expect(saveUser.mock.calls[0]?.[0].status).toBe("pending");
    expect(saveUser.mock.calls[1]?.[0].status).toBe("rejected");
    expect(deleteApprovalTokensByUserId).toHaveBeenCalledTimes(2);
  });
});
