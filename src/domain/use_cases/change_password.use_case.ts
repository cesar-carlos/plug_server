import { User } from "../entities/user.entity";
import type { IPasswordHasher } from "../ports/password_hasher.port";
import type { IUserRepository } from "../repositories/user.repository.interface";
import { unauthorized } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export interface ChangePasswordInput {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export class ChangePasswordUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
  ) {}

  async execute(input: ChangePasswordInput): Promise<Result<void>> {
    const user = await this.userRepository.findById(input.userId);

    if (!user) {
      return err(unauthorized("Invalid credentials"));
    }

    const isMatch = await this.passwordHasher.compare(input.currentPassword, user.passwordHash);
    if (!isMatch) {
      return err(unauthorized("Invalid credentials"));
    }

    const newPasswordHash = await this.passwordHasher.hash(input.newPassword);

    const updatedUser = new User({
      id: user.id,
      email: user.email,
      passwordHash: newPasswordHash,
      role: user.role,
      createdAt: user.createdAt,
    });

    await this.userRepository.save(updatedUser);
    return ok(undefined);
  }
}
