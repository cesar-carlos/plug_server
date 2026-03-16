import { User, type UserRole } from "../entities/user.entity";
import type { IUserRepository } from "../repositories/user.repository.interface";
import { conflict } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export interface RegisterInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly role?: UserRole;
}

export class RegisterUseCase {
  constructor(private readonly userRepository: IUserRepository) {}

  async execute(input: RegisterInput): Promise<Result<User>> {
    const existing = await this.userRepository.findByEmail(input.email);
    if (existing) {
      return err(conflict("Email already in use"));
    }

    const user = User.create({
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role ?? "user",
    });

    await this.userRepository.save(user);
    return ok(user);
  }
}
