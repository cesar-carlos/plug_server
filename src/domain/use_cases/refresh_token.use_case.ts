import type { User } from "../entities/user.entity";
import type { IUserRepository } from "../repositories/user.repository.interface";
import type { IRefreshTokenRepository } from "../repositories/refresh_token.repository.interface";
import { invalidToken, notFound } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export interface RefreshTokenInput {
  readonly tokenId: string;
  readonly userId: string;
}

export class RefreshTokenUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly refreshTokenRepository: IRefreshTokenRepository,
  ) {}

  async execute(input: RefreshTokenInput): Promise<Result<User>> {
    const consumeStatus = await this.refreshTokenRepository.consume(
      input.tokenId,
      input.userId,
      new Date(),
    );
    if (consumeStatus === "not_found") {
      return err(invalidToken("Refresh token not found"));
    }

    if (consumeStatus === "user_mismatch") {
      return err(invalidToken("Refresh token does not belong to this user"));
    }

    if (consumeStatus === "revoked") {
      return err(invalidToken("Refresh token has been revoked"));
    }

    if (consumeStatus === "expired") {
      return err(invalidToken("Refresh token has expired"));
    }

    const user = await this.userRepository.findById(input.userId);
    if (!user) {
      return err(notFound("User"));
    }

    return ok(user);
  }
}
