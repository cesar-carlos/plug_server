import type { Client } from "../../domain/entities/client.entity";
import type { User } from "../../domain/entities/user.entity";
import type { IClientPasswordRecoveryTokenRepository } from "../../domain/repositories/client_password_recovery_token.repository.interface";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import type { ClientAuthTokensDto, ClientAuthUserDto } from "../dtos/client_auth.dto";
import { env } from "../../shared/config/env";
import { badRequest, notFound } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { buildClientWithRotatedCredentials } from "../../shared/utils/client_credential_rotation";
import { parseExpiryToDate } from "../../shared/utils/date";
import { generateOpaqueClientRegistrationToken } from "../../shared/utils/client_registration_token";
import { signAccessToken, signRefreshToken } from "../../shared/utils/jwt";
import { ClientRefreshToken } from "../../domain/entities/client_refresh_token.entity";
import { v4 as uuidv4 } from "uuid";

/**
 * Pure helpers shared by the client auth/registration/profile/management/
 * password-recovery services. Extracted from the legacy `ClientAuthService`
 * god class so the small services don't duplicate token issuance, DTO
 * mapping or registration-token generation.
 */

export const toClientAuthUserDto = (client: Client): ClientAuthUserDto => ({
  id: client.id,
  userId: client.userId,
  email: client.email,
  name: client.name,
  lastName: client.lastName,
  ...(client.mobile !== undefined ? { mobile: client.mobile } : {}),
  ...(client.thumbnailUrl !== undefined ? { thumbnailUrl: client.thumbnailUrl } : {}),
  status: client.status,
  role: "client",
});

export interface ClientRegistrationApprovalTokenSeed {
  readonly id: string;
  readonly clientId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export const newClientRegistrationApprovalToken = (
  clientId: string,
): ClientRegistrationApprovalTokenSeed => ({
  id: generateOpaqueClientRegistrationToken(),
  clientId,
  expiresAt: parseExpiryToDate(env.approvalTokenExpiresIn),
  createdAt: new Date(),
});

export interface ClientRegistrationPollTokenSeed {
  readonly id: string;
  readonly clientId: string;
  readonly createdAt: Date;
}

export const newClientRegistrationPollToken = (clientId: string): ClientRegistrationPollTokenSeed => ({
  id: generateOpaqueClientRegistrationToken(),
  clientId,
  createdAt: new Date(),
});

export const assertActiveOwner = async (
  userRepository: IUserRepository,
  userId: string,
): Promise<Result<User>> => {
  const owner = await userRepository.findById(userId);
  if (!owner) {
    return err(notFound("Owner user"));
  }
  if (owner.status !== "active") {
    return err(badRequest("Owner email is not eligible to approve client registration"));
  }
  return ok(owner);
};

export const assertActiveOwnerByEmail = async (
  userRepository: IUserRepository,
  ownerEmail: string,
): Promise<Result<User>> => {
  const owner = await userRepository.findByEmail(ownerEmail);
  if (!owner || owner.status !== "active") {
    return err(badRequest("Owner email is not eligible to approve client registration"));
  }
  return ok(owner);
};

/**
 * Signs an access + refresh token pair for the given client and persists the
 * refresh token row. Shared between login, refresh and any future flow that
 * needs to mint a fresh session for an authenticated client.
 */
export const issueClientTokens = async (
  client: Client,
  refreshRepo: Pick<IClientRefreshTokenRepository, "save">,
): Promise<ClientAuthTokensDto> => {
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

  await refreshRepo.save(
    ClientRefreshToken.create({
      id: jti,
      clientId: client.id,
      expiresAt,
    }),
  );
  return { accessToken, refreshToken };
};

export interface RotateClientCredentialsDeps {
  readonly clientRepository: Pick<IClientRepository, "save">;
  readonly clientRefreshTokenRepository: Pick<IClientRefreshTokenRepository, "revokeAllForClient">;
  readonly passwordHasher: IPasswordHasher;
  readonly clientPasswordRecoveryTokenRepository?: Pick<
    IClientPasswordRecoveryTokenRepository,
    "deleteByClientId"
  >;
}

/**
 * Hashes a new password, bumps `credentialsUpdatedAt`, persists the client and
 * revokes all refresh sessions. Optionally clears outstanding recovery tokens.
 */
export const rotateClientCredentialsWithHash = async (
  client: Client,
  passwordHash: string,
  deps: RotateClientCredentialsDeps,
): Promise<Client> => {
  const updated = buildClientWithRotatedCredentials(client, passwordHash);
  await deps.clientRepository.save(updated);
  await deps.clientRefreshTokenRepository.revokeAllForClient(updated.id);
  if (deps.clientPasswordRecoveryTokenRepository) {
    await deps.clientPasswordRecoveryTokenRepository.deleteByClientId(updated.id);
  }
  return updated;
};

export const rotateClientCredentials = async (
  client: Client,
  newPassword: string,
  deps: RotateClientCredentialsDeps,
): Promise<Client> => {
  const passwordHash = await deps.passwordHasher.hash(newPassword);
  return rotateClientCredentialsWithHash(client, passwordHash, deps);
};

export type { IPasswordHasher };
