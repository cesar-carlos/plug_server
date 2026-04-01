import { User } from "../entities/user.entity";
import type { IUserRepository } from "../repositories/user.repository.interface";
import { conflict, forbidden, notFound } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";

export interface UpdateMyCelularInput {
  readonly userId: string;
  /** `null` clears the stored mobile number. */
  readonly celular: string | null;
}

export class UpdateMyCelularUseCase {
  constructor(private readonly userRepository: IUserRepository) {}

  async execute(input: UpdateMyCelularInput): Promise<Result<User>> {
    const user = await this.userRepository.findById(input.userId);
    if (!user) {
      return err(notFound("User"));
    }
    if (user.status === "blocked") {
      return err(forbidden("Account is blocked"));
    }

    const nextCelular: string | undefined =
      input.celular === null ? undefined : input.celular;

    const current = user.celular;
    if (current === nextCelular) {
      return ok(user);
    }

    if (nextCelular !== undefined) {
      const taken = await this.userRepository.findByCelular(nextCelular);
      if (taken !== null && taken.id !== user.id) {
        return err(conflict("Phone number already in use"));
      }
    }

    const updated = new User({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      ...(nextCelular !== undefined ? { celular: nextCelular } : {}),
    });

    await this.userRepository.save(updated);
    return ok(updated);
  }
}
