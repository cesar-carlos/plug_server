import type { ClientRefreshToken } from "../entities/client_refresh_token.entity";

export type ConsumeClientRefreshTokenStatus =
  | "consumed"
  | "not_found"
  | "client_mismatch"
  | "revoked"
  | "expired";

export interface IClientRefreshTokenRepository {
  findById(id: string): Promise<ClientRefreshToken | null>;
  save(token: ClientRefreshToken): Promise<void>;
  revoke(id: string): Promise<void>;
  revokeAllForClient(clientId: string): Promise<void>;
  consume(id: string, clientId: string, now: Date): Promise<ConsumeClientRefreshTokenStatus>;
}
