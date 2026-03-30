import { v4 as uuidv4 } from "uuid";

import { RefreshToken } from "../../domain/entities/refresh_token.entity";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type { User } from "../../domain/entities/user.entity";
import type { IRefreshTokenRepository } from "../../domain/repositories/refresh_token.repository.interface";
import type { ApproveRegistrationUseCase } from "../../domain/use_cases/approve_registration.use_case";
import type { ChangePasswordUseCase } from "../../domain/use_cases/change_password.use_case";
import type { GetRegistrationStatusUseCase } from "../../domain/use_cases/get_registration_status.use_case";
import type { LoginUseCase } from "../../domain/use_cases/login.use_case";
import type { LogoutUseCase } from "../../domain/use_cases/logout.use_case";
import type { RefreshTokenUseCase } from "../../domain/use_cases/refresh_token.use_case";
import type { RegisterUseCase } from "../../domain/use_cases/register.use_case";
import type { RejectRegistrationUseCase } from "../../domain/use_cases/reject_registration.use_case";
import type { AgentAccessService } from "./agent_access.service";
import { env } from "../../shared/config/env";
import { type Result, ok } from "../../shared/errors/result";
import { parseExpiryToDate } from "../../shared/utils/date";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../shared/utils/jwt";
import { logger } from "../../shared/utils/logger";
import { generateOpaqueRegistrationToken } from "../../shared/utils/registration_token";
import type {
  AgentAuthResponseDto,
  AuthResponseDto,
  AuthTokensDto,
  AuthUserDto,
  RegisterPendingResponseDto,
  RegistrationStatusResponseDto,
} from "../dtos/auth.dto";

export interface RegisterServiceInput {
  readonly email: string;
  readonly password: string;
}

export interface RegisterServiceOptions {
  readonly requestId?: string;
}

export interface RegistrationActionOptions {
  readonly requestId?: string;
}

export interface LoginServiceInput {
  readonly email: string;
  readonly password: string;
}

export interface ChangePasswordServiceInput {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface AgentLoginServiceInput {
  readonly email: string;
  readonly password: string;
  readonly agentId: string;
}

export class AuthService {
  constructor(
    private readonly registerUseCase: RegisterUseCase,
    private readonly loginUseCase: LoginUseCase,
    private readonly changePasswordUseCase: ChangePasswordUseCase,
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly approveRegistrationUseCase: ApproveRegistrationUseCase,
    private readonly rejectRegistrationUseCase: RejectRegistrationUseCase,
    private readonly getRegistrationStatusUseCase: GetRegistrationStatusUseCase,
    private readonly passwordHasher: IPasswordHasher,
    private readonly refreshTokenRepository: IRefreshTokenRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
    private readonly agentAccessService: AgentAccessService,
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
    });
    if (!result.ok) return result;

    const { user, approvalToken } = result.value;
    const requestId = options?.requestId;
    const tokenPrefix = approvalToken.id.slice(0, 8);

    const dispatchEmails = async (): Promise<void> => {
      await this.emailSender.sendAdminApprovalRequest({
        userEmail: user.email,
        reviewToken: approvalToken.id,
      });
      await this.emailSender.sendUserPendingRegistration({ email: user.email });
    };

    if (env.registrationEmailAsync) {
      void dispatchEmails().catch((error: unknown) => {
        logger.error("registration_email_dispatch_failed", {
          requestId,
          tokenPrefix,
          userId: user.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      try {
        await dispatchEmails();
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
      },
    };

    if (env.nodeEnv !== "production") {
      return ok({ ...dto, approvalToken: approvalToken.id });
    }

    return ok(dto);
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
        email: result.value.email,
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
        email: result.value.email,
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

  async login(input: LoginServiceInput): Promise<Result<AuthResponseDto>> {
    const result = await this.loginUseCase.execute({
      email: input.email,
      plainPassword: input.password,
    });
    if (!result.ok) return result;

    const tokens = await this.issueTokens(result.value);
    return ok({ user: this.toUserDto(result.value), ...tokens });
  }

  async agentLogin(input: AgentLoginServiceInput): Promise<Result<AgentAuthResponseDto>> {
    const result = await this.loginUseCase.execute({
      email: input.email,
      plainPassword: input.password,
    });
    if (!result.ok) return result;

    const accessResult = await this.agentAccessService.assertAccess(result.value.id, input.agentId);
    if (!accessResult.ok) return accessResult;

    const tokens = await this.issueAgentTokens(result.value, input.agentId);
    return ok({
      user: {
        id: result.value.id,
        email: result.value.email,
        role: "agent",
        agentId: input.agentId,
      },
      ...tokens,
    });
  }

  async changePassword(input: ChangePasswordServiceInput): Promise<Result<void>> {
    return this.changePasswordUseCase.execute(input);
  }

  async refresh(rawRefreshToken: string): Promise<Result<AuthTokensDto>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);
    if (!verifyResult.ok) return verifyResult;

    const { sub: userId, jti: tokenId, agent_id: agentId } = verifyResult.value;

    const result = await this.refreshTokenUseCase.execute({ tokenId, userId });
    if (!result.ok) return result;

    if (typeof agentId === "string" && agentId.trim() !== "") {
      return ok(await this.issueAgentTokens(result.value, agentId));
    }
    return ok(await this.issueTokens(result.value));
  }

  async logout(rawRefreshToken: string): Promise<Result<void>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);

    if (!verifyResult.ok) {
      // Silently succeed — an invalid token is already effectively logged out
      return ok(undefined);
    }

    return this.logoutUseCase.execute(verifyResult.value.jti);
  }

  private async issueTokens(user: User): Promise<AuthTokensDto> {
    const jti = uuidv4();
    const expiresAt = parseExpiryToDate(env.jwtRefreshExpiresIn);

    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenType: "access",
    });
    const refreshToken = signRefreshToken({ sub: user.id, jti, tokenType: "refresh" });

    await this.refreshTokenRepository.save(
      RefreshToken.create({ id: jti, userId: user.id, expiresAt }),
    );

    return { accessToken, refreshToken };
  }

  private async issueAgentTokens(user: User, agentId: string): Promise<AuthTokensDto> {
    const jti = uuidv4();
    const expiresAt = parseExpiryToDate(env.jwtRefreshExpiresIn);

    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      role: "agent",
      agent_id: agentId,
      tokenType: "access",
    });
    const refreshToken = signRefreshToken({
      sub: user.id,
      jti,
      tokenType: "refresh",
      agent_id: agentId,
    });

    await this.refreshTokenRepository.save(
      RefreshToken.create({ id: jti, userId: user.id, expiresAt }),
    );

    return { accessToken, refreshToken };
  }

  private toUserDto(user: User): AuthUserDto {
    return { id: user.id, email: user.email, role: user.role };
  }
}
