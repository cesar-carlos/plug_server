import { Client } from "../../domain/entities/client.entity";
import type { IClientPasswordRecoveryTokenRepository } from "../../domain/repositories/client_password_recovery_token.repository.interface";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import { env } from "../../shared/config/env";
import { notFound, registrationTokenExpired } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { isExpired, parseExpiryToDate } from "../../shared/utils/date";
import { generateOpaqueClientPasswordRecoveryToken } from "../../shared/utils/client_password_recovery_token";
import { logger } from "../../shared/utils/logger";
import { redactEmail } from "../../shared/utils/pii_redaction";
import type { ClientAuthService } from "./client_auth.service";

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
    private readonly clientRefreshTokenRepository: IClientRefreshTokenRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly emailSender: IEmailSender,
    private readonly authService: Pick<ClientAuthService, "getActiveClient">,
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
      logger.error("client_password_recovery_email_failed", {
        clientEmailRedacted: redactEmail(client.email),
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return ok(undefined);
  }

  async getPasswordRecoveryStatus(
    tokenId: string,
  ): Promise<Result<{ status: "pending" | "expired" }>> {
    const token = await this.clientPasswordRecoveryTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Password recovery token"));
    }
    if (isExpired(token.expiresAt)) {
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
      return err(registrationTokenExpired("This password recovery link has expired"));
    }

    const active = await this.authService.getActiveClient(token.clientId);
    if (!active.ok) {
      await this.clientPasswordRecoveryTokenRepository.deleteById(tokenId);
      if (active.error.code === "NOT_FOUND") {
        return err(notFound("Client"));
      }
      return active;
    }

    const updated = new Client({
      ...active.value,
      passwordHash: await this.passwordHasher.hash(newPassword),
      credentialsUpdatedAt: new Date(),
      updatedAt: new Date(),
    });
    await this.clientRepository.save(updated);
    await this.clientPasswordRecoveryTokenRepository.deleteById(tokenId);
    await this.clientRefreshTokenRepository.revokeAllForClient(updated.id);
    return ok(undefined);
  }
}
