import type { RefreshToken } from "../entities/refresh_token.entity";

export interface IRefreshTokenRepository {
  findById(id: string): Promise<RefreshToken | null>;
  save(token: RefreshToken): Promise<void>;
  revoke(id: string): Promise<void>;
}
