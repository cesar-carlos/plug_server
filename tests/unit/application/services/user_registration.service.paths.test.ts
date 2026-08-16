import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UserRegistrationService } from "../../../../src/application/services/user_registration.service";
import { RegistrationApprovalToken } from "../../../../src/domain/entities/registration_approval_token.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import { env } from "../../../../src/shared/config/env";
import { conflict, notFound } from "../../../../src/shared/errors/http_errors";
import { err, ok } from "../../../../src/shared/errors/result";
import { logger } from "../../../../src/shared/utils/logger";

const originalNodeEnv = env.nodeEnv;
const originalEmailAsync = env.registrationEmailAsync;

const pendingUser = User.create({
  id: "f7a5f000-7c03-4fca-8fca-c9cf216bb3f4",
  email: "pending@test.com",
  passwordHash: "hashed-password",
  role: "user",
  status: "pending",
  celular: "+5511987654321",
});

const approvalToken = RegistrationApprovalToken.create({
  id: "opaque-token-review-flow",
  userId: pendingUser.id,
  expiresAt: new Date("2099-12-31T00:00:00.000Z"),
});

describe("UserRegistrationService remaining paths", () => {
  const registerExecute = vi.fn();
  const approveExecute = vi.fn();
  const rejectExecute = vi.fn();
  const statusExecute = vi.fn();
  const hash = vi.fn();
  const compare = vi.fn();
  const findById = vi.fn();
  const findByEmail = vi.fn();
  const saveUser = vi.fn();
  const findReviewSummaryById = vi.fn();
  const findTokenById = vi.fn();
  const replaceForUserRetry = vi.fn();
  const deleteByUserId = vi.fn();
  const sendAdminApprovalRequest = vi.fn();
  const sendUserPendingRegistration = vi.fn();
  const sendUserApproved = vi.fn();
  const sendUserRejected = vi.fn();

  const buildService = (): UserRegistrationService =>
    new UserRegistrationService(
      { execute: registerExecute } as never,
      { execute: approveExecute } as never,
      { execute: rejectExecute } as never,
      { execute: statusExecute } as never,
      {
        save: vi.fn(),
        replaceForUserRetry,
        findById: findTokenById,
        findReviewSummaryById,
        deleteById: vi.fn(),
        deleteByUserId,
      } as never,
      {
        findById,
        findByEmail,
        findByCelular: vi.fn(),
        findActiveSnapshotById: vi.fn(),
        save: saveUser,
      } as never,
      { hash, compare } as never,
      {
        sendAdminApprovalRequest,
        sendUserPendingRegistration,
        sendUserApproved,
        sendUserRejected,
      } as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = false;
    (env as { registrationEmailMaxRetries: number }).registrationEmailMaxRetries = 1;
    (env as { registrationEmailRetryDelayMs: number }).registrationEmailRetryDelayMs = 0;
    (env as { nodeEnv: typeof env.nodeEnv }).nodeEnv = originalNodeEnv;
    hash.mockResolvedValue("hashed-password");
    compare.mockResolvedValue(true);
    registerExecute.mockResolvedValue(ok({ user: pendingUser, approvalToken }));
    sendAdminApprovalRequest.mockResolvedValue(undefined);
    sendUserPendingRegistration.mockResolvedValue(undefined);
    sendUserApproved.mockResolvedValue(undefined);
    sendUserRejected.mockResolvedValue(undefined);
    replaceForUserRetry.mockResolvedValue(undefined);
    deleteByUserId.mockResolvedValue(undefined);
    saveUser.mockResolvedValue(undefined);
  });

  afterEach(() => {
    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = originalEmailAsync;
    (env as { nodeEnv: typeof env.nodeEnv }).nodeEnv = originalNodeEnv;
  });

  it("propagates register use-case failures", async () => {
    registerExecute.mockResolvedValue(err(conflict("Email already registered")));
    const result = await buildService().register({
      email: pendingUser.email,
      password: "Password1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("includes celular and omits the approval token in production", async () => {
    (env as { nodeEnv: typeof env.nodeEnv }).nodeEnv = "production";
    const result = await buildService().register({
      email: pendingUser.email,
      password: "Password1",
      celular: pendingUser.celular,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.approvalToken).toBeUndefined();
    expect(result.value.user.celular).toBe("+5511987654321");
  });

  it("logs and swallows async registration email dispatch failures", async () => {
    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = true;
    sendAdminApprovalRequest.mockRejectedValue(new Error("smtp async failure"));
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const result = await buildService().register({
      email: pendingUser.email,
      password: "Password1",
    });
    expect(result.ok).toBe(true);

    await vi.waitFor(() => {
      expect(loggerError).toHaveBeenCalledWith(
        "registration_email_dispatch_failed",
        expect.objectContaining({ message: expect.stringContaining("smtp async failure") }),
      );
    });
    loggerError.mockRestore();
  });

  it("returns a generic false result when retrying a missing or ineligible account", async () => {
    findByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce(
      User.create({
        id: pendingUser.id,
        email: pendingUser.email,
        passwordHash: pendingUser.passwordHash,
        role: "user",
        status: "active",
      }),
    );
    const service = buildService();
    await expect(
      service.retryRejectedRegistration({ email: pendingUser.email, password: "Password1" }),
    ).resolves.toEqual({ ok: true, value: { retried: false } });
    await expect(
      service.retryRejectedRegistration({ email: pendingUser.email, password: "Password1" }),
    ).resolves.toEqual({ ok: true, value: { retried: false } });
  });

  it("logs and keeps retry success when async retry email dispatch fails", async () => {
    (env as { registrationEmailAsync: boolean }).registrationEmailAsync = true;
    findByEmail.mockResolvedValue(
      User.create({
        id: pendingUser.id,
        email: pendingUser.email,
        passwordHash: pendingUser.passwordHash,
        role: "user",
        status: "rejected",
      }),
    );
    sendAdminApprovalRequest.mockRejectedValue("smtp string failure");
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const result = await buildService().retryRejectedRegistration({
      email: pendingUser.email,
      password: "Password1",
    });
    expect(result).toEqual({ ok: true, value: { retried: true } });

    await vi.waitFor(() => {
      expect(loggerError).toHaveBeenCalledWith(
        "registration_retry_email_dispatch_failed",
        expect.objectContaining({ message: expect.any(String) }),
      );
    });
    loggerError.mockRestore();
  });

  it("uses the review-summary projection when it is available", async () => {
    findReviewSummaryById.mockResolvedValueOnce({
      email: pendingUser.email,
      status: "pending",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    findReviewSummaryById.mockResolvedValueOnce({
      email: pendingUser.email,
      status: "pending",
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    const service = buildService();
    await expect(service.getRegistrationReviewSummary("token-pending")).resolves.toEqual({
      email: pendingUser.email,
      status: "pending",
      tokenStatus: "pending",
    });
    await expect(service.getRegistrationReviewSummary("token-expired")).resolves.toEqual({
      email: pendingUser.email,
      status: "pending",
      tokenStatus: "expired",
    });
  });

  it("falls back to token and user lookups for review summaries", async () => {
    findReviewSummaryById.mockResolvedValue(null);
    findTokenById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(approvalToken)
      .mockResolvedValueOnce(
        RegistrationApprovalToken.create({
          id: "expired-token",
          userId: pendingUser.id,
          expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        }),
      );
    findById.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingUser);

    const service = buildService();
    await expect(service.getRegistrationReviewSummary("missing")).resolves.toBeNull();
    await expect(service.getRegistrationReviewSummary("orphan")).resolves.toBeNull();
    await expect(service.getRegistrationReviewSummary("expired")).resolves.toEqual({
      email: pendingUser.email,
      status: "pending",
      tokenStatus: "expired",
    });
  });

  it("approves a registration even when the user email fails", async () => {
    approveExecute.mockResolvedValue(ok(pendingUser));
    sendUserApproved.mockRejectedValue(new Error("smtp approved failed"));
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const result = await buildService().approveRegistration("token-1", { requestId: "req-1" });
    expect(result).toEqual({ ok: true, value: { email: pendingUser.email } });
    expect(loggerError).toHaveBeenCalledWith(
      "registration_approve_user_email_failed",
      expect.objectContaining({ message: "smtp approved failed" }),
    );
    loggerError.mockRestore();
  });

  it("propagates approve use-case failures", async () => {
    approveExecute.mockResolvedValue(err(notFound("Approval link is invalid or has expired")));
    const result = await buildService().approveRegistration("token-1");
    expect(result.ok).toBe(false);
  });

  it("rejects a registration with a trimmed reason and continues if email fails", async () => {
    rejectExecute.mockResolvedValue(ok(pendingUser));
    sendUserRejected.mockRejectedValue("smtp rejected failed");
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const result = await buildService().rejectRegistration("token-1", "  no thanks  ", {
      requestId: "req-2",
    });
    expect(result).toEqual({ ok: true, value: { email: pendingUser.email } });
    expect(sendUserRejected).toHaveBeenCalledWith({
      email: pendingUser.email,
      reason: "no thanks",
    });
    expect(loggerError).toHaveBeenCalledWith(
      "registration_reject_user_email_failed",
      expect.objectContaining({ message: "smtp rejected failed" }),
    );
    loggerError.mockRestore();
  });

  it("rejects without a reason when the comment is blank", async () => {
    rejectExecute.mockResolvedValue(ok(pendingUser));
    const result = await buildService().rejectRegistration("token-1", "   ");
    expect(result.ok).toBe(true);
    expect(sendUserRejected).toHaveBeenCalledWith({ email: pendingUser.email });
  });

  it("propagates reject use-case failures", async () => {
    rejectExecute.mockResolvedValue(err(notFound("Rejection link is invalid or has expired")));
    const result = await buildService().rejectRegistration("token-1");
    expect(result.ok).toBe(false);
  });

  it("delegates public registration status to the use case", async () => {
    statusExecute.mockResolvedValue(ok({ status: "pending" }));
    const result = await buildService().getRegistrationStatus("token-1");
    expect(result).toEqual({ ok: true, value: { status: "pending" } });
    expect(statusExecute).toHaveBeenCalledWith("token-1");
  });
});
