import { RegistrationApprovalToken } from "../../domain/entities/registration_approval_token.entity";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import type { IRegistrationApprovalTokenRepository } from "../../domain/repositories/registration_approval_token.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import type { ApproveRegistrationUseCase } from "../../domain/use_cases/approve_registration.use_case";
import type { GetRegistrationStatusUseCase } from "../../domain/use_cases/get_registration_status.use_case";
import type { RegisterUseCase } from "../../domain/use_cases/register.use_case";
import type { RejectRegistrationUseCase } from "../../domain/use_cases/reject_registration.use_case";
import { enqueueRegistrationApprovalEmails } from "./registration_email_outbox.service";
import { env } from "../../shared/config/env";
import { type Result, ok } from "../../shared/errors/result";
import { isExpired, parseExpiryToDate } from "../../shared/utils/date";
import { logger } from "../../shared/utils/logger";
import { redactEmail } from "../../shared/utils/pii_redaction";
import { generateOpaqueRegistrationToken } from "../../shared/utils/registration_token";
import { withRetry } from "../../shared/utils/retry";
import { reopenRejectedUserRegistration } from "../../domain/policies/user_registration_status.policy";
import type {
  RegisterPendingResponseDto,
  RegistrationStatusResponseDto,
} from "../dtos/auth.dto";

export interface RegisterServiceInput {
  readonly email: string;
  readonly password: string;
  /** E.164 when provided (validated at HTTP layer) */
  readonly celular?: string;
}

export interface RegisterServiceOptions {
  readonly requestId?: string;
}

export interface RegistrationActionOptions {
  readonly requestId?: string;
}

export interface RetryRegistrationServiceInput {
  readonly email: string;
  readonly password: string;
}

export interface RetryRegistrationServiceResult {
  readonly retried: boolean;
}

export interface RegistrationReviewSummary {
  readonly email: string;
  readonly status: "pending" | "active" | "rejected" | "blocked";
  readonly tokenStatus: "pending" | "expired";
}

/**
 * End-to-end user registration flow: `register`, retry of rejected
 * registrations, owner review summaries, owner-decision (approve/reject)
 * and the public status-poll endpoint.
 */
export class UserRegistrationService {
  constructor(
    private readonly registerUseCase: RegisterUseCase,
    private readonly approveRegistrationUseCase: ApproveRegistrationUseCase,
    private readonly rejectRegistrationUseCase: RejectRegistrationUseCase,
    private readonly getRegistrationStatusUseCase: GetRegistrationStatusUseCase,
    private readonly approvalTokenRepository: IRegistrationApprovalTokenRepository,
    private readonly userRepository: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly emailSender: IEmailSender,
  ) {}

  async register(
    input: RegisterServiceInput,
    options?: RegisterServiceOptions,
  ): Promise<Result<RegisterPendingResponseDto>> {
    const passwordHash = await this.passwordHasher.hash(input.password);
    const approvalTokenExpiresAt = parseExpiryToDate(env.approvalTokenExpiresIn);
    const approvalTokenId = generateOpaqueRegistrationToken();

    const result = await this.registerUseCase.execute({
      email: input.email,
      passwordHash,
      approvalTokenExpiresAt,
      approvalTokenId,
      ...(input.celular !== undefined ? { celular: input.celular } : {}),
    });
    if (!result.ok) return result;

    const { user, approvalToken } = result.value;
    const requestId = options?.requestId;
    const tokenPrefix = approvalToken.id.slice(0, 8);

    if (env.registrationEmailAsync) {
      const queued = await enqueueRegistrationApprovalEmails({
        userEmail: user.email,
        reviewToken: approvalToken.id,
      });

      if (!queued) {
        void this.dispatchRegistrationApprovalEmails({
          userEmail: user.email,
          reviewToken: approvalToken.id,
        }).catch((error: unknown) => {
          logger.error("registration_email_dispatch_failed", {
            requestId,
            tokenPrefix,
            userId: user.id,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } else {
      try {
        await this.dispatchRegistrationApprovalEmails({
          userEmail: user.email,
          reviewToken: approvalToken.id,
        });
      } catch (error: unknown) {
        logger.error("registration_email_dispatch_failed", {
          requestId,
          tokenPrefix,
          userId: user.id,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    logger.info("registration_pending_created", {
      requestId,
      tokenPrefix,
      userId: user.id,
    });

    const dto: RegisterPendingResponseDto = {
      message:
        "Registration submitted. You will receive an email notification once your account is reviewed.",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        ...(user.celular !== undefined ? { celular: user.celular } : {}),
      },
    };

    if (env.nodeEnv !== "production") {
      return ok({ ...dto, approvalToken: approvalToken.id });
    }

    return ok(dto);
  }

  async retryRejectedRegistration(
    input: RetryRegistrationServiceInput,
    options?: RegisterServiceOptions,
  ): Promise<Result<RetryRegistrationServiceResult>> {
    const user = await this.userRepository.findByEmail(input.email);
    if (!user || user.status !== "rejected") {
      return ok({ retried: false });
    }

    const passwordMatch = await this.passwordHasher.compare(input.password, user.passwordHash);
    if (!passwordMatch) {
      return ok({ retried: false });
    }

    const approvalToken = RegistrationApprovalToken.create({
      id: generateOpaqueRegistrationToken(),
      userId: user.id,
      expiresAt: parseExpiryToDate(env.approvalTokenExpiresIn),
    });
    const pendingUserResult = reopenRejectedUserRegistration(user);
    if (!pendingUserResult.ok) {
      return ok({ retried: false });
    }
    const pendingUser = pendingUserResult.value;

    try {
      await this.approvalTokenRepository.replaceForUserRetry(pendingUser, approvalToken);
      await this.userRepository.save(pendingUser);
    } catch (error: unknown) {
      await this.approvalTokenRepository.deleteByUserId(user.id);
      await this.userRepository.save(user);
      logger.error("registration_retry_persist_failed", {
        requestId: options?.requestId,
        userId: user.id,
        emailRedacted: redactEmail(user.email),
        message: error instanceof Error ? error.message : String(error),
      });
      return ok({ retried: false });
    }

    try {
      if (env.registrationEmailAsync) {
        const queued = await enqueueRegistrationApprovalEmails({
          userEmail: user.email,
          reviewToken: approvalToken.id,
        });
        if (!queued) {
          void this.dispatchRegistrationApprovalEmails({
            userEmail: user.email,
            reviewToken: approvalToken.id,
          }).catch((error: unknown) => {
            logger.error("registration_retry_email_dispatch_failed", {
              requestId: options?.requestId,
              tokenPrefix: approvalToken.id.slice(0, 8),
              userId: user.id,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return ok({ retried: true });
      }

      await this.dispatchRegistrationApprovalEmails({
        userEmail: user.email,
        reviewToken: approvalToken.id,
      });
      return ok({ retried: true });
    } catch (error: unknown) {
      await this.approvalTokenRepository.deleteByUserId(user.id);
      await this.userRepository.save(user);
      logger.error("registration_retry_email_dispatch_failed", {
        requestId: options?.requestId,
        tokenPrefix: approvalToken.id.slice(0, 8),
        userId: user.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return ok({ retried: false });
    }
  }

  async getRegistrationReviewSummary(tokenId: string): Promise<RegistrationReviewSummary | null> {
    const summary = await this.approvalTokenRepository.findReviewSummaryById(tokenId);
    if (summary) {
      return {
        email: summary.email,
        status: summary.status,
        tokenStatus: isExpired(summary.expiresAt) ? "expired" : "pending",
      };
    }

    const token = await this.approvalTokenRepository.findById(tokenId);
    if (!token) {
      return null;
    }

    const user = await this.userRepository.findById(token.userId);
    if (!user) {
      return null;
    }

    return {
      email: user.email,
      status: user.status,
      tokenStatus: isExpired(token.expiresAt) ? "expired" : "pending",
    };
  }

  async approveRegistration(
    tokenId: string,
    options?: RegistrationActionOptions,
  ): Promise<Result<{ email: string }>> {
    logger.info("registration_approve_request", {
      requestId: options?.requestId,
      tokenPrefix: tokenId.slice(0, 8),
    });

    const result = await this.approveRegistrationUseCase.execute(tokenId);
    if (!result.ok) return result;

    try {
      await this.emailSender.sendUserApproved({ email: result.value.email });
    } catch (error: unknown) {
      logger.error("registration_approve_user_email_failed", {
        requestId: options?.requestId,
        emailRedacted: redactEmail(result.value.email),
        message: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("registration_approved", {
      requestId: options?.requestId,
      userId: result.value.id,
    });

    return ok({ email: result.value.email });
  }

  async rejectRegistration(
    tokenId: string,
    reason?: string,
    options?: RegistrationActionOptions,
  ): Promise<Result<{ email: string }>> {
    logger.info("registration_reject_request", {
      requestId: options?.requestId,
      tokenPrefix: tokenId.slice(0, 8),
    });

    const result = await this.rejectRegistrationUseCase.execute(tokenId);
    if (!result.ok) return result;

    try {
      const trimmedReason = reason?.trim();
      await this.emailSender.sendUserRejected({
        email: result.value.email,
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      });
    } catch (error: unknown) {
      logger.error("registration_reject_user_email_failed", {
        requestId: options?.requestId,
        emailRedacted: redactEmail(result.value.email),
        message: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("registration_rejected", {
      requestId: options?.requestId,
      userId: result.value.id,
    });

    return ok({ email: result.value.email });
  }

  async getRegistrationStatus(tokenId: string): Promise<Result<RegistrationStatusResponseDto>> {
    return this.getRegistrationStatusUseCase.execute(tokenId);
  }

  private async dispatchRegistrationApprovalEmails(input: {
    readonly userEmail: string;
    readonly reviewToken: string;
  }): Promise<void> {
    await Promise.all([
      this.sendWithRetry("sendAdminApprovalRequest", async () =>
        this.emailSender.sendAdminApprovalRequest({
          userEmail: input.userEmail,
          reviewToken: input.reviewToken,
        }),
      ),
      this.sendWithRetry("sendUserPendingRegistration", async () =>
        this.emailSender.sendUserPendingRegistration({ email: input.userEmail }),
      ),
    ]);
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

// Re-export common type names so legacy imports from `auth.service.ts` keep
// resolving until consumers migrate.
export type {
  RegistrationReviewSummary as UserRegistrationReviewSummary,
};
