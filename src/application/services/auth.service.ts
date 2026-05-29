import { User } from "../../domain/entities/user.entity";
import { TtlCache } from "../../shared/utils/ttl_cache";
import type { IRefreshTokenRepository } from "../../domain/repositories/refresh_token.repository.interface";
import type {
  IUserRepository,
  UserActiveSnapshot,
} from "../../domain/repositories/user.repository.interface";
import type { ChangePasswordUseCase } from "../../domain/use_cases/change_password.use_case";
import type { LoginUseCase } from "../../domain/use_cases/login.use_case";
import type { LogoutUseCase } from "../../domain/use_cases/logout.use_case";
import type { RefreshTokenUseCase } from "../../domain/use_cases/refresh_token.use_case";
import type { AgentAccessService } from "./agent_access.service";
import { env } from "../../shared/config/env";
import { forbidden, invalidToken, notFound } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { verifyRefreshToken } from "../../shared/utils/jwt";
import type { JwtAccessPayload } from "../../shared/utils/jwt";
import type {
  AgentAuthResponseDto,
  AuthResponseDto,
  AuthTokensDto,
  MeUserResponseDto,
} from "../dtos/auth.dto";
import { issueUserTokens, toUserAuthDto } from "./user_auth_helpers";

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

/**
 * Session-oriented auth service for users: login, agent-login, refresh,
 * logout, active-account lookups with TTL-cached snapshot, `changePassword`
 * and `getMeProfile`. Registration and admin/account-mutation flows now
 * live in `UserRegistrationService` and `UserAccountService`.
 */
export class AuthService {
  /**
   * Short-lived cache for `getActiveAccountUserSnapshot`.
   * Key: `"${userId}:${credentialsVersion}"` — a password/credentials change
   * issues a new access token with a different `credentials_version`, making
   * the old cache key unreachable without explicit invalidation.
   * Set `PRINCIPAL_SNAPSHOT_CACHE_TTL_MS=0` to disable.
   */
  private readonly snapshotCache = new TtlCache<string, UserActiveSnapshot>(
    env.principalSnapshotCacheTtlMs,
    env.principalSnapshotCacheMaxSize,
  );

  constructor(
    private readonly loginUseCase: LoginUseCase,
    private readonly changePasswordUseCase: ChangePasswordUseCase,
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly refreshTokenRepository: IRefreshTokenRepository,
    private readonly userRepository: IUserRepository,
    private readonly agentAccessService: AgentAccessService,
  ) {}

  /**
   * Loads the user and returns 403 when `blocked`, 404 when missing.
   * When `preloaded` is set and `preloaded.id === userId`, skips `findById` (same HTTP request after
   * the active-account middleware stored the row in `response.locals.activeAccountUser`).
   */
  async getActiveAccountUser(
    userId: string,
    preloaded?: User,
    accessTokenCredentialsVersion?: number,
  ): Promise<Result<User>> {
    if (preloaded !== undefined && preloaded.id === userId) {
      if (preloaded.status === "blocked") {
        return err(forbidden("Account is blocked"));
      }
      if (
        typeof accessTokenCredentialsVersion === "number" &&
        preloaded.credentialsUpdatedAt.getTime() > accessTokenCredentialsVersion
      ) {
        return err(invalidToken("Invalid or expired access token"));
      }
      return ok(preloaded);
    }

    const user = await this.userRepository.findById(userId);
    if (!user) {
      return err(notFound("User"));
    }
    if (user.status === "blocked") {
      return err(forbidden("Account is blocked"));
    }
    if (
      typeof accessTokenCredentialsVersion === "number" &&
      user.credentialsUpdatedAt.getTime() > accessTokenCredentialsVersion
    ) {
      return err(invalidToken("Invalid or expired access token"));
    }
    return ok(user);
  }

  async assertAccountNotBlocked(userId: string): Promise<Result<void>> {
    const result = await this.getActiveAccountUser(userId);
    if (!result.ok) {
      return result;
    }
    return ok(undefined);
  }

  /**
   * Hot-path equivalent of `getActiveAccountUser` that fetches only the columns
   * needed to validate `status` and `credentials_version`. Used by socket auth
   * (handshake + per-event guard) to avoid loading `password_hash` etc. on every
   * relay/command. Same `forbidden`/`notFound`/`invalidToken` semantics.
   */
  async getActiveAccountUserSnapshot(
    userId: string,
    accessTokenCredentialsVersion?: number,
  ): Promise<Result<UserActiveSnapshot>> {
    if (env.principalSnapshotCacheTtlMs > 0 && typeof accessTokenCredentialsVersion === "number") {
      const key = `${userId}:${accessTokenCredentialsVersion}`;
      const cached = this.snapshotCache.get(key);
      if (cached !== undefined) {
        return ok(cached);
      }
    }

    const snapshot = await this.userRepository.findActiveSnapshotById(userId);
    if (!snapshot) {
      return err(notFound("User"));
    }
    if (snapshot.status === "blocked") {
      return err(forbidden("Account is blocked"));
    }
    if (
      typeof accessTokenCredentialsVersion === "number" &&
      snapshot.credentialsUpdatedAt.getTime() > accessTokenCredentialsVersion
    ) {
      return err(invalidToken("Invalid or expired access token"));
    }

    if (env.principalSnapshotCacheTtlMs > 0 && typeof accessTokenCredentialsVersion === "number") {
      this.snapshotCache.set(`${userId}:${accessTokenCredentialsVersion}`, snapshot);
    }
    return ok(snapshot);
  }

  /** Evicts all cached snapshots for `userId` (e.g. immediately after blocking). */
  invalidateSnapshotCache(userId: string): void {
    this.snapshotCache.deleteWhere((key) => key.startsWith(`${userId}:`));
  }

  async getMeProfile(
    jwtUser: JwtAccessPayload,
    preloadedUser?: User,
  ): Promise<Result<MeUserResponseDto>> {
    const userResult = await this.getActiveAccountUser(
      jwtUser.sub,
      preloadedUser,
      jwtUser.credentials_version,
    );
    if (!userResult.ok) {
      if (userResult.error.code === "NOT_FOUND") {
        return err(notFound("User"));
      }
      return userResult;
    }
    const user = userResult.value;
    const role =
      typeof jwtUser.role === "string" && jwtUser.role.trim() !== "" ? jwtUser.role : user.role;
    return ok({
      id: user.id,
      sub: user.id,
      email: user.email,
      role,
      status: user.status,
      ...(user.celular !== undefined ? { celular: user.celular } : {}),
      ...(typeof jwtUser.agent_id === "string" && jwtUser.agent_id.trim() !== ""
        ? { agentId: jwtUser.agent_id }
        : {}),
    });
  }

  async login(input: LoginServiceInput): Promise<Result<AuthResponseDto>> {
    const result = await this.loginUseCase.execute({
      email: input.email,
      plainPassword: input.password,
    });
    if (!result.ok) return result;

    const tokens = await issueUserTokens(result.value, this.refreshTokenRepository);
    return ok({ user: toUserAuthDto(result.value), ...tokens });
  }

  async agentLogin(input: AgentLoginServiceInput): Promise<Result<AgentAuthResponseDto>> {
    const result = await this.loginUseCase.execute({
      email: input.email,
      plainPassword: input.password,
    });
    if (!result.ok) return result;

    const accessResult = await this.agentAccessService.assertAgentLoginAllowed(
      result.value.id,
      input.agentId,
    );
    if (!accessResult.ok) return accessResult;

    const tokens = await issueUserTokens(result.value, this.refreshTokenRepository, input.agentId);
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
    const result = await this.changePasswordUseCase.execute(input);
    if (!result.ok) {
      return result;
    }

    const user = await this.userRepository.findById(input.userId);
    if (!user) {
      return err(notFound("User"));
    }

    const now = new Date();
    const updatedUser = new User({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      credentialsUpdatedAt: now,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      ...(user.celular !== undefined ? { celular: user.celular } : {}),
    });

    await this.userRepository.save(updatedUser);
    await this.refreshTokenRepository.revokeAllForUser(user.id);
    return ok(undefined);
  }

  async refresh(rawRefreshToken: string): Promise<Result<AuthTokensDto>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);
    if (!verifyResult.ok) return verifyResult;

    const { sub: userId, jti: tokenId, agent_id: agentId } = verifyResult.value;

    const result = await this.refreshTokenUseCase.execute({ tokenId, userId });
    if (!result.ok) return result;

    if (typeof agentId === "string" && agentId.trim() !== "") {
      return ok(await issueUserTokens(result.value, this.refreshTokenRepository, agentId));
    }
    return ok(await issueUserTokens(result.value, this.refreshTokenRepository));
  }

  async logout(rawRefreshToken: string): Promise<Result<void>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);

    if (!verifyResult.ok) {
      // Silently succeed — an invalid token is already effectively logged out
      return ok(undefined);
    }

    return this.logoutUseCase.execute(verifyResult.value.jti);
  }
}
