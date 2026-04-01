import type { RefreshToken } from "../entities/refresh_token.entity";

export type ConsumeRefreshTokenStatus =
  | "consumed"
  | "not_found"
  | "user_mismatch"
  | "revoked"
  | "expired";

export interface IRefreshTokenRepository {
  findById(id: string): Promise<RefreshToken | null>;
  save(token: RefreshToken): Promise<void>;
  revoke(id: string): Promise<void>;
  /** Revokes all non-revoked refresh tokens for the user (e.g. when blocking the account). */
  revokeAllForUser(userId: string): Promise<void>;
  consume(id: string, userId: string, now: Date): Promise<ConsumeRefreshTokenStatus>;
}
