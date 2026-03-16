import type { User } from "../entities/user.entity";
import type { IUserRepository } from "../repositories/user.repository.interface";
import type { IPasswordHasher } from "../ports/password_hasher.port";
import { unauthorized } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export interface LoginInput {
  readonly email: string;
  readonly plainPassword: string;
}

export class LoginUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
  ) {}

  async execute(input: LoginInput): Promise<Result<User>> {
    const user = await this.userRepository.findByEmail(input.email);

    // Use the same error for missing user and wrong password to prevent user enumeration
    if (!user) {
      return err(unauthorized("Invalid email or password"));
    }

    const isMatch = await this.passwordHasher.compare(input.plainPassword, user.passwordHash);
    if (!isMatch) {
      return err(unauthorized("Invalid email or password"));
    }

    return ok(user);
  }
}
