import type { Client } from "../../domain/entities/client.entity";
import { TtlCache } from "../../shared/utils/ttl_cache";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import type { IClientPasswordRecoveryTokenRepository } from "../../domain/repositories/client_password_recovery_token.repository.interface";
import type {
  ClientActiveSnapshot,
  IClientRepository,
} from "../../domain/repositories/client.repository.interface";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type {
  ClientAuthResponseDto,
  ClientAuthTokensDto,
  ClientAuthUserDto,
} from "../dtos/client_auth.dto";
import { env } from "../../shared/config/env";
import {
  badRequest,
  forbidden,
  invalidToken,
  notFound,
  unauthorized,
} from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { verifyRefreshToken } from "../../shared/utils/jwt";
import { assertClientCanLogin } from "../../domain/policies/client_registration_status.policy";
import { issueClientTokens, rotateClientCredentials, toClientAuthUserDto } from "./client_auth_helpers";

export interface LoginClientServiceInput {
  readonly email: string;
  readonly password: string;
}

export interface ChangeClientPasswordServiceInput {
  readonly clientId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

/**
 * Session-oriented client auth service. Owns login/refresh/logout, the
 * `getActiveClient(+Snapshot)` lookup (with TTL-cached snapshot) and the
 * `changePassword` flow. Registration, owner-side client management, profile
 * mutations and password recovery now live in their own focused services.
 */
export class ClientAuthService {
  /**
   * Short-lived cache for `getActiveClientSnapshot`.
   * Key: `"${clientId}:${credentialsVersion}"` — a password change issues a
   * new access token with a different `credentials_version`, automatically
   * invalidating the old cache key without explicit cleanup.
   * Set `PRINCIPAL_SNAPSHOT_CACHE_TTL_MS=0` to disable.
   */
  private readonly snapshotCache = new TtlCache<string, ClientActiveSnapshot>(
    env.principalSnapshotCacheTtlMs,
    env.principalSnapshotCacheMaxSize,
  );

  constructor(
    private readonly clientRepository: IClientRepository,
    private readonly clientRefreshTokenRepository: IClientRefreshTokenRepository,
    private readonly clientPasswordRecoveryTokenRepository: IClientPasswordRecoveryTokenRepository,
    private readonly passwordHasher: IPasswordHasher,
  ) {}

  async login(input: LoginClientServiceInput): Promise<Result<ClientAuthResponseDto>> {
    const client = await this.clientRepository.findByEmail(input.email);
    if (!client) {
      return err(unauthorized("Invalid credentials"));
    }
    if (client.status === "blocked") {
      return err(forbidden("Client account is blocked"));
    }
    if (client.status !== "active") {
      return err(unauthorized("Invalid credentials"));
    }

    const passwordMatch = await this.passwordHasher.compare(input.password, client.passwordHash);
    if (!passwordMatch) {
      return err(unauthorized("Invalid credentials"));
    }

    const tokens = await issueClientTokens(client, this.clientRefreshTokenRepository);
    return ok({
      client: toClientAuthUserDto(client),
      ...tokens,
    });
  }

  async refresh(rawRefreshToken: string): Promise<Result<ClientAuthTokensDto>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);
    if (!verifyResult.ok) {
      return verifyResult;
    }
    if (verifyResult.value.principal_type !== "client") {
      return err(badRequest("Refresh token is not a client session token"));
    }

    const { sub: clientId, jti: tokenId } = verifyResult.value;
    const consumed = await this.clientRefreshTokenRepository.consume(tokenId, clientId, new Date());
    if (consumed !== "consumed") {
      return err(unauthorized("Invalid or expired refresh token"));
    }

    const client = await this.clientRepository.findById(clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    const canLogin = assertClientCanLogin(client.status);
    if (!canLogin.ok) {
      return canLogin;
    }
    return ok(await issueClientTokens(client, this.clientRefreshTokenRepository));
  }

  async logout(rawRefreshToken: string): Promise<Result<void>> {
    const verifyResult = verifyRefreshToken(rawRefreshToken);
    if (!verifyResult.ok) {
      return ok(undefined);
    }
    if (verifyResult.value.principal_type !== "client") {
      return ok(undefined);
    }
    await this.clientRefreshTokenRepository.revoke(verifyResult.value.jti);
    return ok(undefined);
  }

  async getActiveClient(
    clientId: string,
    preloaded?: Client,
    accessTokenCredentialsVersion?: number,
  ): Promise<Result<Client>> {
    const client =
      preloaded?.id === clientId ? preloaded : await this.clientRepository.findById(clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    const canLogin = assertClientCanLogin(client.status);
    if (!canLogin.ok) {
      return canLogin;
    }
    if (
      typeof accessTokenCredentialsVersion === "number" &&
      client.credentialsUpdatedAt.getTime() !== accessTokenCredentialsVersion
    ) {
      return err(invalidToken("Access token is no longer valid"));
    }
    return ok(client);
  }

  /**
   * Hot-path equivalent of `getActiveClient` that fetches only the columns
   * needed to validate `status` and `credentials_version`. Used by socket auth
   * (handshake + per-event guard) to avoid loading `password_hash`, profile
   * and address columns on every relay/command. Same `forbidden`/`notFound`/
   * `invalidToken` semantics as `getActiveClient`.
   */
  async getActiveClientSnapshot(
    clientId: string,
    accessTokenCredentialsVersion?: number,
  ): Promise<Result<ClientActiveSnapshot>> {
    if (env.principalSnapshotCacheTtlMs > 0 && typeof accessTokenCredentialsVersion === "number") {
      const key = `${clientId}:${accessTokenCredentialsVersion}`;
      const cached = this.snapshotCache.get(key);
      if (cached !== undefined) {
        return ok(cached);
      }
    }

    const snapshot = await this.clientRepository.findActiveSnapshotById(clientId);
    if (!snapshot) {
      return err(notFound("Client"));
    }
    const canLogin = assertClientCanLogin(snapshot.status);
    if (!canLogin.ok) {
      return canLogin;
    }
    if (
      typeof accessTokenCredentialsVersion === "number" &&
      snapshot.credentialsUpdatedAt.getTime() !== accessTokenCredentialsVersion
    ) {
      return err(invalidToken("Access token is no longer valid"));
    }

    if (env.principalSnapshotCacheTtlMs > 0 && typeof accessTokenCredentialsVersion === "number") {
      this.snapshotCache.set(`${clientId}:${accessTokenCredentialsVersion}`, snapshot);
    }
    return ok(snapshot);
  }

  /** Evicts all cached snapshots for `clientId` (e.g. after status change). */
  invalidateSnapshotCache(clientId: string): void {
    this.snapshotCache.deleteWhere((key) => key.startsWith(`${clientId}:`));
  }

  async getMeProfile(clientId: string, preloaded?: Client): Promise<Result<ClientAuthUserDto>> {
    const active = await this.getActiveClient(clientId, preloaded);
    if (!active.ok) {
      return active;
    }
    return ok(toClientAuthUserDto(active.value));
  }

  async changePassword(input: ChangeClientPasswordServiceInput): Promise<Result<void>> {
    const active = await this.getActiveClient(input.clientId);
    if (!active.ok) {
      if (active.error.code === "NOT_FOUND") {
        return err(unauthorized("Invalid credentials"));
      }
      return active;
    }

    const isMatch = await this.passwordHasher.compare(
      input.currentPassword,
      active.value.passwordHash,
    );
    if (!isMatch) {
      return err(unauthorized("Invalid credentials"));
    }

    await rotateClientCredentials(active.value, input.newPassword, {
      clientRepository: this.clientRepository,
      clientRefreshTokenRepository: this.clientRefreshTokenRepository,
      passwordHasher: this.passwordHasher,
      clientPasswordRecoveryTokenRepository: this.clientPasswordRecoveryTokenRepository,
    });
    return ok(undefined);
  }
}
