import { Client, type ClientStatus } from "../../domain/entities/client.entity";
import type { IClientRegistrationDecisionTxn } from "../../domain/ports/client_registration_decision_txn.port";
import type { IClientRegistrationRegisterTxn } from "../../domain/ports/client_registration_register_txn.port";
import type { IClientRegistrationApprovalTokenRepository } from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { IClientRegistrationPollTokenRepository } from "../../domain/repositories/client_registration_poll_token.repository.interface";
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
  serviceUnavailable,
} from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { isExpired } from "../../shared/utils/date";
import { logger } from "../../shared/utils/logger";
import { redactEmail } from "../../shared/utils/pii_redaction";
import { withRetry } from "../../shared/utils/retry";
import {
  isClientRegistrationResendEligible,
  reopenRejectedClientRegistration,
} from "../../domain/policies/client_registration_status.policy";
import type { ClientRegistrationDecisionResult } from "../../domain/ports/client_registration_decision_txn.port";
import {
  recordClientRegistrationPublicDecisionFinished,
  recordClientRegistrationPublicDecisionStarted,
  type ClientRegistrationPublicDecision,
  type ClientRegistrationPublicDecisionOutcome,
} from "../../shared/metrics/client_registration_public_decision.metrics";
import {
  assertActiveOwner,
  assertActiveOwnerByEmail,
  newClientRegistrationApprovalToken,
  newClientRegistrationPollToken,
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

const GENERIC_REGISTER_ACCEPTED_MESSAGE =
  "If eligible, your registration request will be processed.";

/**
 * End-to-end client registration flow: `register`, retry/resend of rejected or
 * expired-pending registrations, owner review summaries, owner-decision
 * (approve/reject) and the status-poll endpoint for the registering client.
 */
export class ClientRegistrationService {
  constructor(
    private readonly clientRepository: IClientRepository,
    private readonly clientRegistrationApprovalTokenRepository: IClientRegistrationApprovalTokenRepository,
    private readonly clientRegistrationPollTokenRepository: IClientRegistrationPollTokenRepository,
    private readonly clientRegistrationRegisterTxn: IClientRegistrationRegisterTxn,
    private readonly clientRegistrationDecisionTxn: IClientRegistrationDecisionTxn,
    private readonly userRepository: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly emailSender: IEmailSender,
  ) {}

  async register(
    input: RegisterClientServiceInput,
  ): Promise<Result<ClientRegistrationRequestResponseDto>> {
    const ownerResult = await assertActiveOwnerByEmail(this.userRepository, input.ownerEmail);
    if (!ownerResult.ok) {
      return ownerResult;
    }
    const owner = ownerResult.value;

    const existing = await this.clientRepository.findByEmail(input.email);
    if (existing) {
      return ok({
        message: GENERIC_REGISTER_ACCEPTED_MESSAGE,
        duplicate: true,
      });
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
    const pollToken = newClientRegistrationPollToken(client.id);
    try {
      await this.clientRegistrationRegisterTxn.registerPending({
        client,
        approvalToken,
        pollToken,
      });
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
      registrationPollToken: pollToken.id,
      ...(env.nodeEnv !== "production" ? { approvalToken: approvalToken.id } : {}),
    });
  }

  async retryClientRegistration(
    input: RetryClientRegistrationServiceInput,
  ): Promise<Result<RetryClientRegistrationServiceResult>> {
    const client = await this.clientRepository.findByEmail(input.email);
    if (!client) {
      return ok({ retried: false });
    }

    const approvalToken = await this.clientRegistrationApprovalTokenRepository.findByClientId(
      client.id,
    );
    const approvalTokenExpired = approvalToken === null || isExpired(approvalToken.expiresAt);
    if (!isClientRegistrationResendEligible(client.status, approvalTokenExpired)) {
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

    let pendingClient = client;
    if (client.status === "rejected") {
      const pendingClientResult = reopenRejectedClientRegistration(client);
      if (!pendingClientResult.ok) {
        return ok({ retried: false });
      }
      pendingClient = pendingClientResult.value;
    }

    const previousApprovalToken = approvalToken
      ? {
          id: approvalToken.id,
          clientId: approvalToken.clientId,
          expiresAt: approvalToken.expiresAt,
          createdAt: approvalToken.createdAt,
        }
      : null;
    const newApprovalToken = newClientRegistrationApprovalToken(client.id);

    try {
      await this.clientRegistrationApprovalTokenRepository.replaceForClientRetry(
        pendingClient,
        newApprovalToken,
      );
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
        approvalToken: newApprovalToken.id,
      });
      return ok({ retried: true });
    } catch (error: unknown) {
      try {
        await this.clientRegistrationApprovalTokenRepository.deleteById(newApprovalToken.id);
        if (previousApprovalToken) {
          await this.clientRegistrationApprovalTokenRepository.save(previousApprovalToken);
        }
        if (client.status === "rejected") {
          await this.clientRepository.save(client);
        }
      } catch (rollbackError: unknown) {
        logger.error("client_registration_retry_rollback_failed", {
          clientId: client.id,
          clientEmailRedacted: redactEmail(client.email),
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      logger.error("client_registration_retry_email_failed", {
        clientId: client.id,
        clientEmailRedacted: redactEmail(client.email),
        message: error instanceof Error ? error.message : String(error),
      });
      return ok({ retried: false });
    }
  }

  /** @deprecated Use {@link retryClientRegistration} */
  async retryRejectedRegistration(
    input: RetryClientRegistrationServiceInput,
  ): Promise<Result<RetryClientRegistrationServiceResult>> {
    return this.retryClientRegistration(input);
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
    const startedAtMs = Date.now();
    recordClientRegistrationPublicDecisionStarted("approve");
    return this.wrapRegistrationDecisionTxn(
      "approve",
      () => this.clientRegistrationDecisionTxn.approve(tokenId),
      undefined,
      startedAtMs,
    );
  }

  async rejectRegistration(
    tokenId: string,
    reason?: string,
  ): Promise<Result<{ clientEmail: string }>> {
    const startedAtMs = Date.now();
    recordClientRegistrationPublicDecisionStarted("reject");
    return this.wrapRegistrationDecisionTxn(
      "reject",
      () => this.clientRegistrationDecisionTxn.reject(tokenId),
      reason,
      startedAtMs,
    );
  }

  async approveByOwner(
    ownerUserId: string,
    clientId: string,
  ): Promise<Result<{ clientEmail: string }>> {
    const ownerResult = await assertActiveOwner(this.userRepository, ownerUserId);
    if (!ownerResult.ok) {
      return ownerResult;
    }

    const client = await this.clientRepository.findById(clientId);
    if (!client || client.userId !== ownerUserId) {
      return err(notFound("Client"));
    }
    if (client.status !== "pending") {
      return err(conflict("Client registration already processed"));
    }

    return this.wrapRegistrationDecisionTxn(
      "approve",
      () => this.clientRegistrationDecisionTxn.approveByClientId(clientId),
      undefined,
      Date.now(),
    );
  }

  async rejectByOwner(
    ownerUserId: string,
    clientId: string,
    reason?: string,
  ): Promise<Result<{ clientEmail: string }>> {
    const ownerResult = await assertActiveOwner(this.userRepository, ownerUserId);
    if (!ownerResult.ok) {
      return ownerResult;
    }

    const client = await this.clientRepository.findById(clientId);
    if (!client || client.userId !== ownerUserId) {
      return err(notFound("Client"));
    }
    if (client.status !== "pending") {
      return err(conflict("Client registration already processed"));
    }

    return this.wrapRegistrationDecisionTxn(
      "reject",
      () => this.clientRegistrationDecisionTxn.rejectByClientId(clientId),
      reason,
      Date.now(),
    );
  }

  async getRegistrationStatus(
    tokenId: string,
  ): Promise<Result<{ status: ClientRegistrationPollStatus }>> {
    const pollToken = await this.clientRegistrationPollTokenRepository.findById(tokenId);
    if (!pollToken) {
      return ok({ status: "unknown" });
    }

    const client = await this.clientRepository.findById(pollToken.clientId);
    if (!client) {
      return ok({ status: "unknown" });
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

    const approvalToken = await this.clientRegistrationApprovalTokenRepository.findByClientId(
      client.id,
    );
    if (!approvalToken || isExpired(approvalToken.expiresAt)) {
      return ok({ status: "expired" });
    }

    return ok({ status: "pending" });
  }

  private async wrapRegistrationDecisionTxn(
    action: ClientRegistrationPublicDecision,
    run: () => Promise<ClientRegistrationDecisionResult>,
    reason?: string,
    startedAtMs?: number,
  ): Promise<Result<{ clientEmail: string }>> {
    try {
      const decision = await run();
      return this.mapClientRegistrationDecision(decision, action, startedAtMs, reason);
    } catch (error: unknown) {
      logger.error("client_registration_decision_txn_failed", {
        action,
        message: error instanceof Error ? error.message : String(error),
      });
      return err(
        serviceUnavailable(
          action === "approve"
            ? "N\u00e3o foi poss\u00edvel concluir a aprova\u00e7\u00e3o. Tente novamente em instantes."
            : "N\u00e3o foi poss\u00edvel concluir a recusa. Tente novamente em instantes.",
        ),
      );
    }
  }

  private mapClientRegistrationDecision(
    decision: ClientRegistrationDecisionResult,
    action: ClientRegistrationPublicDecision,
    startedAtMs?: number,
    reason?: string,
  ): Result<{ clientEmail: string }> {
    if (decision.status === "client_not_found") {
      this.recordPublicRegistrationDecisionOutcome(action, "client_missing", startedAtMs);
      return err(notFound("Client"));
    }
    if (decision.status === "owner_inactive") {
      this.recordPublicRegistrationDecisionOutcome(action, "owner_ineligible", startedAtMs);
      return err(badRequest("Owner email is not eligible to approve client registration"));
    }
    if (decision.status === "expired") {
      this.recordPublicRegistrationDecisionOutcome(action, "expired", startedAtMs);
      return err(
        registrationTokenExpired(
          action === "approve"
            ? "This approval link has expired"
            : "This rejection link has expired",
        ),
      );
    }
    if (decision.status === "not_pending") {
      this.recordPublicRegistrationDecisionOutcome(action, "already_processed", startedAtMs);
      return err(conflict("Client registration already processed"));
    }
    if (decision.status === "not_found") {
      this.recordPublicRegistrationDecisionOutcome(action, "invalid_token", startedAtMs);
      return err(notFound("Approval link is invalid or has expired"));
    }

    const decided = decision.client;
    this.recordPublicRegistrationDecisionOutcome(
      action,
      action === "approve" ? "approved" : "rejected",
      startedAtMs,
    );
    void this.notifyClientRegistrationDecision(decided.email, action, reason);
    return ok({ clientEmail: decided.email });
  }

  private recordPublicRegistrationDecisionOutcome(
    decision: ClientRegistrationPublicDecision,
    outcome: ClientRegistrationPublicDecisionOutcome,
    startedAtMs?: number,
  ): void {
    if (startedAtMs === undefined) {
      return;
    }
    recordClientRegistrationPublicDecisionFinished({
      decision,
      outcome,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });
  }

  private async notifyClientRegistrationDecision(
    clientEmail: string,
    action: "approve" | "reject",
    reason?: string,
  ): Promise<void> {
    try {
      if (action === "approve") {
        await this.emailSender.sendClientRegistrationApproved({ clientEmail });
      } else {
        await this.emailSender.sendClientRegistrationRejected({
          clientEmail,
          ...(reason !== undefined ? { reason } : {}),
        });
      }
    } catch (error: unknown) {
      logger.error(
        action === "approve"
          ? "client_registration_approved_email_failed"
          : "client_registration_rejected_email_failed",
        {
          clientEmailRedacted: redactEmail(clientEmail),
          message: error instanceof Error ? error.message : String(error),
        },
      );
    }
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
      await this.clientRegistrationPollTokenRepository.deleteByClientId(clientId);
    } catch (error: unknown) {
      logger.warn("client_registration_poll_token_cleanup_failed", {
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
