import type { Client, ClientStatus } from "../entities/client.entity";

/**
 * Minimal projection used by socket/handshake-time `is the client still active?`
 * checks. Avoids loading `password_hash`, profile, and address columns.
 */
export interface ClientActiveSnapshot {
  readonly id: string;
  readonly status: ClientStatus;
  readonly credentialsUpdatedAt: Date;
}

export interface IClientRepository {
  findById(id: string): Promise<Client | null>;
  findByEmail(email: string): Promise<Client | null>;
  listByUserId(userId: string): Promise<Client[]>;
  /** Active client IDs among `ids`, preserving the input order after de-duplication. */
  findActiveIdsByIds(ids: readonly string[]): Promise<string[]>;
  /** Lightweight projection for hot-path active-account checks (auth handshake, consumer guard). */
  findActiveSnapshotById(id: string): Promise<ClientActiveSnapshot | null>;
  save(client: Client): Promise<void>;
  deleteById(id: string): Promise<void>;
}
