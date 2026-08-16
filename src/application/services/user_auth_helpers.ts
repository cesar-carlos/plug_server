import { randomUUID } from "node:crypto";

import { RefreshToken } from "../../domain/entities/refresh_token.entity";
import type { User } from "../../domain/entities/user.entity";
import type { IRefreshTokenRepository } from "../../domain/repositories/refresh_token.repository.interface";
import type { AuthTokensDto, AuthUserDto } from "../dtos/auth.dto";
import { env } from "../../shared/config/env";
import { parseExpiryToDate } from "../../shared/utils/date";
import { signAccessToken, signRefreshToken } from "../../shared/utils/jwt";

/**
 * Pure helpers shared by the user auth / registration / account services.
 * Centralizes token issuance and DTO mapping so the smaller services do not
 * duplicate the JWT-signing recipe.
 */

export const toUserAuthDto = (user: User): AuthUserDto => ({
  id: user.id,
  email: user.email,
  role: user.role,
});

/**
 * Signs an access + refresh token pair for the given user and persists the
 * refresh-token row. When `agentId` is provided, the access token carries the
 * `agent_id` claim and is tagged `role: "agent"` (used by the agent-login
 * flow). Otherwise the standard user session shape is issued.
 */
export const issueUserTokens = async (
  user: User,
  refreshRepo: Pick<IRefreshTokenRepository, "save">,
  agentId?: string,
): Promise<AuthTokensDto> => {
  const jti = randomUUID();
  const expiresAt = parseExpiryToDate(env.jwtRefreshExpiresIn);
  const credentialsVersion = user.credentialsUpdatedAt.getTime();

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: agentId !== undefined ? "agent" : user.role,
    principal_type: "user",
    credentials_version: credentialsVersion,
    tokenType: "access",
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
  });
  const refreshToken = signRefreshToken({
    sub: user.id,
    jti,
    principal_type: "user",
    tokenType: "refresh",
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
  });

  await refreshRepo.save(RefreshToken.create({ id: jti, userId: user.id, expiresAt }));
  return { accessToken, refreshToken };
};
