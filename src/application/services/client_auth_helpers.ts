import type { Client } from "../../domain/entities/client.entity";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import type { ClientAuthTokensDto, ClientAuthUserDto } from "../dtos/client_auth.dto";
import { env } from "../../shared/config/env";
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

export type { IPasswordHasher };
