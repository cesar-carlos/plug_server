import type { IPasswordHasher } from "../../domain/ports/password_hasher.port";
import { comparePassword, hashPassword } from "../../shared/utils/password";

export class BcryptPasswordHasher implements IPasswordHasher {
  async hash(plain: string): Promise<string> {
    return hashPassword(plain);
  }

  async compare(plain: string, hashedValue: string): Promise<boolean> {
    return comparePassword(plain, hashedValue);
  }
}
