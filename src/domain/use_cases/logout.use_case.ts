import type { IRefreshTokenRepository } from "../repositories/refresh_token.repository.interface";
import { invalidToken } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export class LogoutUseCase {
  constructor(private readonly refreshTokenRepository: IRefreshTokenRepository) {}

  async execute(tokenId: string): Promise<Result<void>> {
    const token = await this.refreshTokenRepository.findById(tokenId);

    if (!token) {
      return err(invalidToken("Refresh token not found"));
    }

    if (token.isRevoked) {
      return ok(undefined);
    }

    await this.refreshTokenRepository.revoke(token.id);
    return ok(undefined);
  }
}
