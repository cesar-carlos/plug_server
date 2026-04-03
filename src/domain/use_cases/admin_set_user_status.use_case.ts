import { User } from "../entities/user.entity";
import type { IRefreshTokenRepository } from "../repositories/refresh_token.repository.interface";
import type { IUserRepository } from "../repositories/user.repository.interface";
import { badRequest, notFound } from "../../shared/errors/http_errors";
import { incrementAdminUserStatusSet } from "../../shared/metrics/auth_account.metrics";
import { type Result, ok, err } from "../../shared/errors/result";

export interface AdminSetUserStatusInput {
  readonly targetUserId: string;
  /** Block any account, or unblock only from `blocked` (reactivate). */
  readonly status: "active" | "blocked";
}

export class AdminSetUserStatusUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly refreshTokenRepository: IRefreshTokenRepository,
  ) {}

  async execute(input: AdminSetUserStatusInput): Promise<Result<User>> {
    const user = await this.userRepository.findById(input.targetUserId);
    if (!user) {
      return err(notFound("User"));
    }

    if (input.status === "blocked") {
      if (user.status === "blocked") {
        return ok(user);
      }
      const blocked = new User({
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        credentialsUpdatedAt: user.credentialsUpdatedAt,
        role: user.role,
        status: "blocked",
        createdAt: user.createdAt,
        ...(user.celular !== undefined ? { celular: user.celular } : {}),
      });
      await this.refreshTokenRepository.revokeAllForUser(user.id);
      await this.userRepository.save(blocked);
      incrementAdminUserStatusSet();
      return ok(blocked);
    }

    if (user.status !== "blocked") {
      return err(
        badRequest("Only blocked accounts can be reactivated via this endpoint; use registration approval for pending users"),
      );
    }

    const active = new User({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      credentialsUpdatedAt: user.credentialsUpdatedAt,
      role: user.role,
      status: "active",
      createdAt: user.createdAt,
      ...(user.celular !== undefined ? { celular: user.celular } : {}),
    });
    await this.userRepository.save(active);
    incrementAdminUserStatusSet();
    return ok(active);
  }
}
