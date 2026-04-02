import type { Client } from "../entities/client.entity";

export interface IClientRepository {
  findById(id: string): Promise<Client | null>;
  findByEmail(email: string): Promise<Client | null>;
  listByUserId(userId: string): Promise<Client[]>;
  save(client: Client): Promise<void>;
  deleteById(id: string): Promise<void>;
}
