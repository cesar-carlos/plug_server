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
    const token = await this.refreshTokenRepository.findById(input.tokenId);

    if (!token) {
      return err(invalidToken("Refresh token not found"));
    }

    if (token.userId !== input.userId) {
      return err(invalidToken("Refresh token does not belong to this user"));
    }

    if (token.isRevoked) {
      return err(invalidToken("Refresh token has been revoked"));
    }

    if (token.isExpired) {
      return err(invalidToken("Refresh token has expired"));
    }

    const user = await this.userRepository.findById(input.userId);
    if (!user) {
      return err(notFound("User"));
    }

    await this.refreshTokenRepository.revoke(token.id);

    return ok(user);
  }
}
