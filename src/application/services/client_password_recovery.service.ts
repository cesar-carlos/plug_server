import type { IClientPasswordRecoveryResetTxn } from "../../domain/ports/client_password_recovery_reset_txn.port";
import type { IClientPasswordRecoveryTokenRepository } from "../../domain/repositories/client_password_recovery_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import { env } from "../../shared/config/env";
import { incrementClientPasswordRecoveryEmailCleanupFailed } from "../../shared/metrics/client_password_recovery.metrics";
import {
  badRequest,
  forbidden,
  notFound,
  passwordRecoveryTokenExpired,
  serviceUnavailable,
} from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { isExpired, parseExpiryToDate } from "../../shared/utils/date";
import { generateOpaqueClientPasswordRecoveryToken } from "../../shared/utils/client_password_recovery_token";
import { logger } from "../../shared/utils/logger";
import { redactEmail } from "../../shared/utils/pii_redaction";

export type ClientPasswordRecoveryPollStatus = "pending" | "expired" | "unknown";

const PASSWORD_RECOVERY_EMAIL_UNAVAILABLE_MESSAGE =
  "Unable to send password recovery email. Please try again later.";

/**
 * Forgot-password flow for clients: issuing recovery tokens, polling
 * pending/expired status, and consuming a token to reset the password.
 * On reset, every active refresh token is revoked so any stolen-cookie
 * scenario is invalidated alongside the password change.
 */
export class ClientPasswordRecoveryService {
  constructor(
    private readonly clientRepository: IClientRepository,
    private readonly clientPasswordRecoveryTokenRepository: IClientPasswordRecoveryTokenRepository,
    private readonly clientPasswordRecoveryResetTxn: IClientPasswordRecoveryResetTxn,
    private readonly passwordHasher: IPasswordHasher,
    private readonly emailSender: IEmailSender,
  ) {}

  async requestPasswordRecovery(email: string): Promise<Result<void>> {
    const client = await this.clientRepository.findByEmail(email);
    if (!client || client.status !== "active") {
      return ok(undefined);
    }

    const tokenId = generateOpaqueClientPasswordRecoveryToken();
    await this.clientPasswordRecoveryTokenRepository.save({
      id: tokenId,
      clientId: client.id,
      expiresAt: parseExpiryToDate(env.clientPasswordRecoveryTokenExpiresIn),
      createdAt: new Date(),
    });
    try {
      await this.emailSender.sendClientPasswordRecovery({
        clientEmail: client.email,
        recoveryToken: tokenId,
      });
    } catch (error: unknown) {
      let cleanupFailed = false;
      try {
        await this.clientPasswordRecoveryTokenRepository.deleteById(tokenId);
      } catch (cleanupError: unknown) {
        cleanupFailed = true;
        incrementClientPasswordRecoveryEmailCleanupFailed();
        logger.error("client_password_recovery_token_cleanup_failed", {
          clientId: client.id,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      logger.error("client_password_recovery_email_failed", {
        clientEmailRedacted: redactEmail(client.email),
        cleanupFailed,
        message: error instanceof Error ? error.message : String(error),
      });
      return err(serviceUnavailable(PASSWORD_RECOVERY_EMAIL_UNAVAILABLE_MESSAGE));
    }
    return ok(undefined);
  }

  async getPasswordRecoveryStatus(
    tokenId: string,
  ): Promise<Result<{ status: ClientPasswordRecoveryPollStatus }>> {
    const token = await this.clientPasswordRecoveryTokenRepository.findById(tokenId);
    if (!token) {
      return ok({ status: "unknown" });
    }

    const client = await this.clientRepository.findById(token.clientId);
    if (!client || client.status !== "active") {
      await this.clientPasswordRecoveryTokenRepository.deleteById(tokenId);
      return ok({ status: "unknown" });
    }

    if (isExpired(token.expiresAt)) {
      await this.clientPasswordRecoveryTokenRepository.deleteById(tokenId);
      return ok({ status: "expired" });
    }
    return ok({ status: "pending" });
  }

  async resetPasswordByRecoveryToken(tokenId: string, newPassword: string): Promise<Result<void>> {
    const token = await this.clientPasswordRecoveryTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Password recovery token"));
    }

    if (isExpired(token.expiresAt)) {
      await this.clientPasswordRecoveryTokenRepository.deleteById(tokenId);
      return err(passwordRecoveryTokenExpired("This password recovery link has expired"));
    }

    const client = await this.clientRepository.findById(token.clientId);
    if (!client) {
      await this.clientPasswordRecoveryTokenRepository.deleteById(tokenId);
      return err(notFound("Password recovery token"));
    }

    if (client.status !== "active") {
      await this.clientPasswordRecoveryTokenRepository.deleteById(tokenId);
      return err(forbidden("Client account is not active"));
    }

    const reusesCurrentPassword = await this.passwordHasher.compare(
      newPassword,
      client.passwordHash,
    );
    if (reusesCurrentPassword) {
      return err(badRequest("New password must be different from current password"));
    }

    const passwordHash = await this.passwordHasher.hash(newPassword);
    const reset = await this.clientPasswordRecoveryResetTxn.resetByToken(tokenId, passwordHash);

    switch (reset.status) {
      case "success":
        return ok(undefined);
      case "expired":
        return err(passwordRecoveryTokenExpired("This password recovery link has expired"));
      case "not_found":
        return err(notFound("Password recovery token"));
      case "client_not_found":
        return err(notFound("Client"));
      case "client_inactive":
        return err(forbidden("Client account is not active"));
    }
  }
}
