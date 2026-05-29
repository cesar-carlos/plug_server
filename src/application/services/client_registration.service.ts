import { Client, type ClientStatus } from "../../domain/entities/client.entity";
import type { IClientRegistrationDecisionTxn } from "../../domain/ports/client_registration_decision_txn.port";
import type { IClientRegistrationApprovalTokenRepository } from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import type {
  ClientRegistrationPollStatus,
  ClientRegistrationRequestResponseDto,
} from "../dtos/client_auth.dto";
import { enqueueClientRegistrationApprovalEmail } from "./registration_email_outbox.service";
import { env } from "../../shared/config/env";
import {
  badRequest,
  conflict,
  notFound,
  registrationTokenExpired,
} from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { isExpired } from "../../shared/utils/date";
import { logger } from "../../shared/utils/logger";
import { redactEmail } from "../../shared/utils/pii_redaction";
import { withRetry } from "../../shared/utils/retry";
import {
  isClientRegistrationRetryEligible,
  reopenRejectedClientRegistration,
} from "../../domain/policies/client_registration_status.policy";
import {
  newClientRegistrationApprovalToken,
  toClientAuthUserDto,
} from "./client_auth_helpers";

export interface RegisterClientServiceInput {
  readonly ownerEmail: string;
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly lastName: string;
  readonly mobile?: string;
}

export interface RetryClientRegistrationServiceInput {
  readonly ownerEmail: string;
  readonly email: string;
  readonly password: string;
}

export interface RetryClientRegistrationServiceResult {
  readonly retried: boolean;
}

export interface ClientRegistrationReviewSummary {
  readonly ownerEmail: string;
  readonly clientEmail: string;
  readonly clientName: string;
  readonly clientStatus: ClientStatus;
  readonly tokenStatus: "pending" | "expired";
}

/**
 * End-to-end client registration flow: `register`, retry of rejected
 * registrations, owner review summaries, owner-decision (approve/reject)
 * and the status-poll endpoint backing the public registration page.
 */
export class ClientRegistrationService {
  constructor(
    private readonly clientRepository: IClientRepository,
    private readonly clientRegistrationApprovalTokenRepository: IClientRegistrationApprovalTokenRepository,
    private readonly clientRegistrationDecisionTxn: IClientRegistrationDecisionTxn,
    private readonly userRepository: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly emailSender: IEmailSender,
  ) {}

  async register(
    input: RegisterClientServiceInput,
  ): Promise<Result<ClientRegistrationRequestResponseDto>> {
    const owner = await this.userRepository.findByEmail(input.ownerEmail);
    if (!owner || owner.status !== "active") {
      return err(badRequest("Owner email is not eligible to approve client registration"));
    }

    const existing = await this.clientRepository.findByEmail(input.email);
    if (existing) {
      return err(conflict("Client email already in use"));
    }

    const passwordHash = await this.passwordHasher.hash(input.password);
    const client = Client.create({
      userId: owner.id,
      email: input.email,
      passwordHash,
      name: input.name,
      lastName: input.lastName,
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
      status: "pending",
    });
    const approvalToken = newClientRegistrationApprovalToken(client.id);
    try {
      await this.clientRepository.save(client);
      await this.clientRegistrationApprovalTokenRepository.save(approvalToken);
      await this.dispatchRegistrationRequestEmail({
        ownerEmail: owner.email,
        clientEmail: client.email,
        clientName: client.name,
        clientLastName: client.lastName,
        approvalToken: approvalToken.id,
      });
    } catch (error) {
      await this.rollbackPendingRegistration(client.id, approvalToken.id);
      throw error;
    }

    return ok({
      message: "Client registration pending owner approval",
      client: toClientAuthUserDto(client),
      ...(env.nodeEnv !== "production" ? { approvalToken: approvalToken.id } : {}),
    });
  }

  async retryRejectedRegistration(
    input: RetryClientRegistrationServiceInput,
  ): Promise<Result<RetryClientRegistrationServiceResult>> {
    const client = await this.clientRepository.findByEmail(input.email);
    if (!client || !isClientRegistrationRetryEligible(client.status)) {
      return ok({ retried: false });
    }

    const owner = await this.userRepository.findById(client.userId);
    if (
      !owner ||
      owner.status !== "active" ||
      owner.email.toLowerCase() !== input.ownerEmail.toLowerCase()
    ) {
      return ok({ retried: false });
    }

    const passwordMatch = await this.passwordHasher.compare(input.password, client.passwordHash);
    if (!passwordMatch) {
      return ok({ retried: false });
    }

    const pendingClientResult = reopenRejectedClientRegistration(client);
    if (!pendingClientResult.ok) {
      return ok({ retried: false });
    }
    const pendingClient = pendingClientResult.value;
    const approvalToken = newClientRegistrationApprovalToken(client.id);

    try {
      // Prisma: atomic transaction rotates token + flips client.status in one DB round-trip.
      // In-memory (test): replaceForClientRetry only saves the token; the explicit save below
      // keeps the in-memory client store in sync and is a no-op in production.
      await this.clientRegistrationApprovalTokenRepository.replaceForClientRetry(
        pendingClient,
        approvalToken,
      );
      await this.clientRepository.save(pendingClient);
    } catch (error: unknown) {
      logger.error("client_registration_retry_persist_failed", {
        clientId: client.id,
        clientEmailRedacted: redactEmail(client.email),
        message: error instanceof Error ? error.message : String(error),
      });
      return ok({ retried: false });
    }

    try {
      await this.dispatchRegistrationRequestEmail({
        ownerEmail: owner.email,
        clientEmail: client.email,
        clientName: client.name,
        clientLastName: client.lastName,
        approvalToken: approvalToken.id,
      });
      return ok({ retried: true });
    } catch (error: unknown) {
      // Best-effort rollback: restore original status.
      await this.clientRegistrationApprovalTokenRepository.deleteById(approvalToken.id);
      await this.clientRepository.save(client);
      logger.error("client_registration_retry_email_failed", {
        clientId: client.id,
        clientEmailRedacted: redactEmail(client.email),
        message: error instanceof Error ? error.message : String(error),
      });
      return ok({ retried: false });
    }
  }

  async getRegistrationReviewSummary(
    tokenId: string,
  ): Promise<ClientRegistrationReviewSummary | null> {
    const summary =
      await this.clientRegistrationApprovalTokenRepository.findReviewSummaryById(tokenId);
    if (summary) {
      return {
        ownerEmail: summary.ownerEmail,
        clientEmail: summary.clientEmail,
        clientName: summary.clientName,
        clientStatus: summary.clientStatus,
        tokenStatus: isExpired(summary.expiresAt) ? "expired" : "pending",
      };
    }

    const token = await this.clientRegistrationApprovalTokenRepository.findById(tokenId);
    if (!token) {
      return null;
    }

    const client = await this.clientRepository.findById(token.clientId);
    if (!client) {
      return null;
    }

    const owner = await this.userRepository.findById(client.userId);
    if (!owner) {
      return null;
    }

    return {
      ownerEmail: owner.email,
      clientEmail: client.email,
      clientName: `${client.name} ${client.lastName}`.trim(),
      clientStatus: client.status,
      tokenStatus: isExpired(token.expiresAt) ? "expired" : "pending",
    };
  }

  async approveRegistration(tokenId: string): Promise<Result<{ clientEmail: string }>> {
    const decision = await this.clientRegistrationDecisionTxn.approve(tokenId);
    if (decision.status === "client_not_found") {
      return err(notFound("Client"));
    }
    if (decision.status === "expired") {
      return err(registrationTokenExpired("This approval link has expired"));
    }
    if (decision.status === "not_pending") {
      return err(conflict("Client registration already processed"));
    }
    if (decision.status === "not_found") {
      return err(notFound("Approval link is invalid or has expired"));
    }

    const approved = decision.client;
    try {
      await this.emailSender.sendClientRegistrationApproved({ clientEmail: approved.email });
    } catch (error: unknown) {
      logger.error("client_registration_approved_email_failed", {
        clientEmailRedacted: redactEmail(approved.email),
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return ok({ clientEmail: approved.email });
  }

  async rejectRegistration(
    tokenId: string,
    reason?: string,
  ): Promise<Result<{ clientEmail: string }>> {
    const decision = await this.clientRegistrationDecisionTxn.reject(tokenId);
    if (decision.status === "client_not_found") {
      return err(notFound("Client"));
    }
    if (decision.status === "expired") {
      return err(registrationTokenExpired("This rejection link has expired"));
    }
    if (decision.status === "not_pending") {
      return err(conflict("Client registration already processed"));
    }
    if (decision.status === "not_found") {
      return err(notFound("Rejection link is invalid or has expired"));
    }

    const rejected = decision.client;
    try {
      await this.emailSender.sendClientRegistrationRejected({
        clientEmail: rejected.email,
        ...(reason !== undefined ? { reason } : {}),
      });
    } catch (error: unknown) {
      logger.error("client_registration_rejected_email_failed", {
        clientEmailRedacted: redactEmail(rejected.email),
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return ok({ clientEmail: rejected.email });
  }

  async getRegistrationStatus(
    tokenId: string,
  ): Promise<Result<{ status: ClientRegistrationPollStatus }>> {
    const token = await this.clientRegistrationApprovalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Registration token"));
    }

    const client = await this.clientRepository.findById(token.clientId);
    if (!client) {
      await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
      return err(notFound("Registration token"));
    }

    if (client.status === "active") {
      return ok({ status: "approved" });
    }
    if (client.status === "rejected") {
      return ok({ status: "rejected" });
    }
    if (client.status === "blocked") {
      return ok({ status: "blocked" });
    }

    if (isExpired(token.expiresAt)) {
      return ok({ status: "expired" });
    }

    return ok({ status: "pending" });
  }

  private async dispatchRegistrationRequestEmail(params: {
    readonly ownerEmail: string;
    readonly clientEmail: string;
    readonly clientName: string;
    readonly clientLastName: string;
    readonly approvalToken: string;
  }): Promise<void> {
    if (env.registrationEmailAsync) {
      const queued = await enqueueClientRegistrationApprovalEmail(params);
      if (queued) {
        return;
      }
    }

    await this.sendWithRetry("sendClientRegistrationRequestToOwner", async () =>
      this.emailSender.sendClientRegistrationRequestToOwner(params),
    );
  }

  private async rollbackPendingRegistration(clientId: string, tokenId: string): Promise<void> {
    try {
      await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
    } catch (error: unknown) {
      logger.warn("client_registration_token_cleanup_failed", {
        clientId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.clientRepository.deleteById(clientId);
    } catch (error: unknown) {
      logger.error("client_registration_cleanup_failed", {
        clientId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendWithRetry(operation: string, action: () => Promise<void>): Promise<void> {
    return withRetry(operation, action, {
      maxAttempts: env.registrationEmailMaxRetries,
      delayMs: env.registrationEmailRetryDelayMs,
      exponential: true,
      maxDelayMs: 30_000,
    });
  }
}
