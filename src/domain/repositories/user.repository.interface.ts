import type { User } from "../entities/user.entity";

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** When celular is stored as E.164 */
  findByCelular(celular: string): Promise<User | null>;
  save(user: User): Promise<void>;
}
