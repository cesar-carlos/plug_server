import { v4 as uuidv4 } from "uuid";

import type { IFileStorage } from "../../domain/ports/file_storage.port";
import { TtlCache } from "../../shared/utils/ttl_cache";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import { Client, type ClientStatus } from "../../domain/entities/client.entity";
import { ClientRefreshToken } from "../../domain/entities/client_refresh_token.entity";
import type { IClientPasswordRecoveryTokenRepository } from "../../domain/repositories/client_password_recovery_token.repository.interface";
import type { IClientRegistrationApprovalTokenRepository } from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type {
  ClientActiveSnapshot,
  IClientRepository,
} from "../../domain/repositories/client.repository.interface";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import type {
  ClientAuthResponseDto,
  ClientRegistrationRequestResponseDto,
  ClientAuthTokensDto,
  ClientAuthUserDto,
} from "../dtos/client_auth.dto";
import { disconnectConsumerPrincipalSockets } from "./consumer_socket_control_sink";
import { enqueueClientRegistrationApprovalEmail } from "./registration_email_outbox.service";
import { env } from "../../shared/config/env";
import {
  badRequest,
  conflict,
  forbidden,
  invalidToken,
  notFound,
  registrationTokenExpired,
  unauthorized,
} from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { isExpired, parseExpiryToDate } from "../../shared/utils/date";
import { generateOpaqueClientRegistrationToken } from "../../shared/utils/client_registration_token";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../shared/utils/jwt";
import { logger } from "../../shared/utils/logger";
import { redactEmail } from "../../shared/utils/pii_redaction";
import { generateOpaqueClientPasswordRecoveryToken } from "../../shared/utils/client_password_recovery_token";
import { withRetry } from "../../shared/utils/retry";

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

export interface LoginClientServiceInput {
  readonly email: string;
  readonly password: string;
}

export interface UpdateMyClientProfileInput {
  readonly name?: string;
  readonly lastName?: string;
  readonly mobile?: string | null;
  readonly thumbnailUrl?: null;
}

export interface ChangeClientPasswordServiceInput {
  readonly clientId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface ListManagedClientsFilter {
  readonly status?: ClientStatus;
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ManagedClientsPage {
  readonly items: ClientAuthUserDto[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

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
    private readonly clientRegistrationApprovalTokenRepository: IClientRegistrationApprovalTokenRepository,
    private readonly userRepository: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly emailSender: IEmailSender,
    private readonly fileStorage: IFileStorage,
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
    const approvalToken = this.newRegistrationApprovalToken(client.id);
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
      client: this.toClientDto(client),
      ...(env.nodeEnv !== "production" ? { approvalToken: approvalToken.id } : {}),
    });
  }

  async retryRejectedRegistration(
    input: RetryClientRegistrationServiceInput,
  ): Promise<Result<RetryClientRegistrationServiceResult>> {
    const client = await this.clientRepository.findByEmail(input.email);
    if (!client || client.status !== "blocked") {
      return ok({ retried: false });
    }

    const owner = await this.userRepository.findById(client.userId);
    if (!owner || owner.status !== "active" || owner.email !== input.ownerEmail) {
      return ok({ retried: false });
    }

    const passwordMatch = await this.passwordHasher.compare(input.password, client.passwordHash);
    if (!passwordMatch) {
      return ok({ retried: false });
    }

    const pendingClient = new Client({
      ...client,
      status: "pending",
      updatedAt: new Date(),
    });
    const approvalToken = this.newRegistrationApprovalToken(client.id);

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

  async getRegistrationReviewSummary(tokenId: string): Promise<ClientRegistrationReviewSummary | null> {
    const summary = await this.clientRegistrationApprovalTokenRepository.findReviewSummaryById(tokenId);
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

  async listManagedClientsPage(
    ownerUserId: string,
    filter?: ListManagedClientsFilter,
  ): Promise<Result<ManagedClientsPage>> {
    const owner = await this.userRepository.findById(ownerUserId);
    if (!owner) {
      return err(notFound("Owner user"));
    }
    if (owner.status !== "active") {
      return err(forbidden("Owner user is not active"));
    }

    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, filter?.pageSize ?? 20));
    let clients = await this.clientRepository.listByUserId(ownerUserId);

    if (filter?.status !== undefined) {
      clients = clients.filter((client) => client.status === filter.status);
    }
    if (filter?.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      clients = clients.filter(
        (client) =>
          client.email.toLowerCase().includes(query) ||
          client.name.toLowerCase().includes(query) ||
          client.lastName.toLowerCase().includes(query),
      );
    }

    const total = clients.length;
    const start = (page - 1) * pageSize;
    const items = clients.slice(start, start + pageSize).map((client) => this.toClientDto(client));
    return ok({
      items,
      total,
      page,
      pageSize,
    });
  }

  async findManagedClient(
    ownerUserId: string,
    clientId: string,
  ): Promise<Result<ClientAuthUserDto>> {
    const owner = await this.userRepository.findById(ownerUserId);
    if (!owner) {
      return err(notFound("Owner user"));
    }
    if (owner.status !== "active") {
      return err(forbidden("Owner user is not active"));
    }

    const client = await this.clientRepository.findById(clientId);
    if (!client || client.userId !== ownerUserId) {
      return err(notFound("Client"));
    }
    return ok(this.toClientDto(client));
  }

  async setManagedClientStatus(
    ownerUserId: string,
    clientId: string,
    status: ClientStatus,
  ): Promise<Result<ClientAuthUserDto>> {
    const owner = await this.userRepository.findById(ownerUserId);
    if (!owner) {
      return err(notFound("Owner user"));
    }
    if (owner.status !== "active") {
      return err(forbidden("Owner user is not active"));
    }

    const client = await this.clientRepository.findById(clientId);
    if (!client || client.userId !== ownerUserId) {
      return err(notFound("Client"));
    }

    if (client.status === status) {
      return ok(this.toClientDto(client));
    }

    if (client.status === "pending") {
      return err(
        conflict(
          "Pending client registrations must be approved or rejected via the registration flow",
        ),
      );
    }

    const updated = new Client({
      ...client,
      status,
      updatedAt: new Date(),
    });
    await this.clientRepository.save(updated);
    if (status === "blocked") {
      this.invalidateSnapshotCache(client.id);
      await this.clientRefreshTokenRepository.revokeAllForClient(client.id);
      await disconnectConsumerPrincipalSockets({
        principalType: "client",
        principalId: client.id,
        reason: "account_blocked",
      });
    }
    return ok(this.toClientDto(updated));
  }

  async login(input: LoginClientServiceInput): Promise<Result<ClientAuthResponseDto>> {
    const client = await this.clientRepository.findByEmail(input.email);
    if (!client) {
      return err(unauthorized("Invalid credentials"));
    }
    if (client.status === "blocked") {
      return err(forbidden("Client account is blocked"));
    }
    if (client.status !== "active") {
      return err(forbidden("Client account is pending approval"));
    }

    const passwordMatch = await this.passwordHasher.compare(input.password, client.passwordHash);
    if (!passwordMatch) {
      return err(unauthorized("Invalid credentials"));
    }

    const tokens = await this.issueTokens(client);
    return ok({
      client: this.toClientDto(client),
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
    if (client.status === "blocked") {
      return err(forbidden("Client account is blocked"));
    }
    if (client.status !== "active") {
      return err(forbidden("Client account is pending approval"));
    }
    return ok(await this.issueTokens(client));
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
    if (client.status === "blocked") {
      return err(forbidden("Client account is blocked"));
    }
    if (client.status !== "active") {
      return err(forbidden("Client account is pending approval"));
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
    if (snapshot.status === "blocked") {
      return err(forbidden("Client account is blocked"));
    }
    if (snapshot.status !== "active") {
      return err(forbidden("Client account is pending approval"));
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

  async updateMyProfile(
    clientId: string,
    input: UpdateMyClientProfileInput,
    preloaded?: Client,
  ): Promise<Result<ClientAuthUserDto>> {
    const active = await this.getActiveClient(clientId, preloaded);
    if (!active.ok) {
      return active;
    }

    const current = active.value;
    const nextName = input.name ?? current.name;
    const nextLastName = input.lastName ?? current.lastName;
    const nextMobile = input.mobile === undefined ? current.mobile : (input.mobile ?? undefined);
    const nextThumbnailUrl = input.thumbnailUrl === undefined ? current.thumbnailUrl : undefined;

    if (
      nextName === current.name &&
      nextLastName === current.lastName &&
      nextMobile === current.mobile &&
      nextThumbnailUrl === current.thumbnailUrl
    ) {
      return ok(this.toClientDto(current));
    }

    const updated = new Client({
      ...current,
      name: nextName,
      lastName: nextLastName,
      ...(nextMobile !== undefined ? { mobile: nextMobile } : {}),
      ...(nextThumbnailUrl !== undefined ? { thumbnailUrl: nextThumbnailUrl } : {}),
      updatedAt: new Date(),
    });
    await this.clientRepository.save(updated);
    if (
      input.thumbnailUrl === null &&
      current.thumbnailUrl?.startsWith(`${env.uploadsPublicBaseUrl}/`)
    ) {
      await this.fileStorage.delete(
        current.thumbnailUrl.slice(`${env.uploadsPublicBaseUrl}/`.length),
      );
    }
    return ok(this.toClientDto(updated));
  }

  async updateThumbnail(
    clientId: string,
    file: {
      readonly buffer: Buffer;
      readonly mimeType: string;
    },
    preloaded?: Client,
  ): Promise<Result<ClientAuthUserDto>> {
    const active = await this.getActiveClient(clientId, preloaded);
    if (!active.ok) {
      return active;
    }

    const current = active.value;
    let stored: { url: string; storageKey: string };
    try {
      stored = await this.fileStorage.saveClientThumbnail({
        clientId: current.id,
        buffer: file.buffer,
        mimeType: file.mimeType,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid thumbnail image file";
      return err(badRequest(message));
    }

    const updated = new Client({
      ...current,
      thumbnailUrl: stored.url,
      updatedAt: new Date(),
    });
    await this.clientRepository.save(updated);

    if (current.thumbnailUrl?.startsWith(env.uploadsPublicBaseUrl)) {
      const prefix = `${env.uploadsPublicBaseUrl}/`;
      const previousStorageKey = current.thumbnailUrl.slice(prefix.length);
      if (previousStorageKey.trim() !== "") {
        await this.fileStorage.delete(previousStorageKey);
      }
    }

    return ok(this.toClientDto(updated));
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

    const updated = new Client({
      ...active.value,
      passwordHash: await this.passwordHasher.hash(input.newPassword),
      credentialsUpdatedAt: new Date(),
      updatedAt: new Date(),
    });
    await this.clientRepository.save(updated);
    await this.clientRefreshTokenRepository.revokeAllForClient(updated.id);
    await this.clientPasswordRecoveryTokenRepository.deleteByClientId(updated.id);
    return ok(undefined);
  }

  async approveRegistration(tokenId: string): Promise<Result<{ clientEmail: string }>> {
    const token = await this.clientRegistrationApprovalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Approval link is invalid or has expired"));
    }

    const client = await this.clientRepository.findById(token.clientId);
    if (!client) {
      await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
      return err(notFound("Client"));
    }

    if (isExpired(token.expiresAt)) {
      await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
      return err(registrationTokenExpired("This approval link has expired"));
    }

    if (client.status !== "pending") {
      await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
      return err(conflict("Client registration already processed"));
    }

    const approved = new Client({
      ...client,
      status: "active",
      updatedAt: new Date(),
    });
    await this.clientRepository.save(approved);
    await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
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
    const token = await this.clientRegistrationApprovalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Rejection link is invalid or has expired"));
    }

    const client = await this.clientRepository.findById(token.clientId);
    if (!client) {
      await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
      return err(notFound("Client"));
    }

    if (isExpired(token.expiresAt)) {
      await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
      return err(registrationTokenExpired("This rejection link has expired"));
    }

    if (client.status !== "pending") {
      await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
      return err(conflict("Client registration already processed"));
    }

    const rejected = new Client({
      ...client,
      status: "blocked",
      updatedAt: new Date(),
    });
    await this.clientRepository.save(rejected);
    await this.clientRegistrationApprovalTokenRepository.deleteById(tokenId);
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

  async getRegistrationStatus(tokenId: string): Promise<Result<{ status: "pending" | "expired" }>> {
    const token = await this.clientRegistrationApprovalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Registration token"));
    }

    if (isExpired(token.expiresAt)) {
      return ok({ status: "expired" });
    }

    return ok({ status: "pending" });
  }

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

    const active = await this.getActiveClient(token.clientId);
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

  async getMeProfile(clientId: string, preloaded?: Client): Promise<Result<ClientAuthUserDto>> {
    const active = await this.getActiveClient(clientId, preloaded);
    if (!active.ok) {
      return active;
    }
    return ok(this.toClientDto(active.value));
  }

  private async issueTokens(client: Client): Promise<ClientAuthTokensDto> {
    const jti = uuidv4();
    const expiresAt = parseExpiryToDate(env.jwtRefreshExpiresIn);
    const accessToken = signAccessToken({
      sub: client.id,
      email: client.email,
      role: "client",
      principal_type: "client",
      credentials_version: client.credentialsUpdatedAt.getTime(),
      tokenType: "access",
    });
    const refreshToken = signRefreshToken({
      sub: client.id,
      jti,
      principal_type: "client",
      tokenType: "refresh",
    });

    await this.clientRefreshTokenRepository.save(
      ClientRefreshToken.create({
        id: jti,
        clientId: client.id,
        expiresAt,
      }),
    );
    return { accessToken, refreshToken };
  }

  private toClientDto(client: Client): ClientAuthUserDto {
    return {
      id: client.id,
      userId: client.userId,
      email: client.email,
      name: client.name,
      lastName: client.lastName,
      ...(client.mobile !== undefined ? { mobile: client.mobile } : {}),
      ...(client.thumbnailUrl !== undefined ? { thumbnailUrl: client.thumbnailUrl } : {}),
      status: client.status,
      role: "client",
    };
  }

  private newRegistrationApprovalToken(clientId: string): {
    id: string;
    clientId: string;
    expiresAt: Date;
    createdAt: Date;
  } {
    return {
      id: generateOpaqueClientRegistrationToken(),
      clientId,
      expiresAt: parseExpiryToDate(env.approvalTokenExpiresIn),
      createdAt: new Date(),
    };
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
