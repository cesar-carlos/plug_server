import type { User, UserStatus } from "../entities/user.entity";

/**
 * Minimal projection used by socket/handshake-time `is the account still active?`
 * checks. Avoids loading `password_hash` and other wide columns.
 */
export interface UserActiveSnapshot {
  readonly id: string;
  readonly status: UserStatus;
  readonly credentialsUpdatedAt: Date;
  readonly role: string;
}

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByIds(ids: readonly string[]): Promise<User[]>;
  findByEmail(email: string): Promise<User | null>;
  /** When celular is stored as E.164 */
  findByCelular(celular: string): Promise<User | null>;
  /** Lightweight projection for hot-path active-account checks (auth handshake, consumer guard). */
  findActiveSnapshotById(id: string): Promise<UserActiveSnapshot | null>;
  save(user: User): Promise<void>;
}
