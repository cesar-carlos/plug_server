import { describe, it, expect, vi, beforeEach } from "vitest";

import { RefreshToken } from "../../../../src/domain/entities/refresh_token.entity";
import type { IRefreshTokenRepository } from "../../../../src/domain/repositories/refresh_token.repository.interface";
import { LogoutUseCase } from "../../../../src/domain/use_cases/logout.use_case";

const makeTokenRepo = (): IRefreshTokenRepository => ({
  findById: vi.fn(),
  save: vi.fn(),
  revoke: vi.fn(),
  revokeAllForUser: vi.fn(),
  consume: vi.fn(),
});

const activeToken = RefreshToken.create({
  id: "active-token",
  userId: "user-1",
  expiresAt: new Date(Date.now() + 86400000),
});

describe("LogoutUseCase", () => {
  let refreshTokenRepository: IRefreshTokenRepository;
  let useCase: LogoutUseCase;

  beforeEach(() => {
    refreshTokenRepository = makeTokenRepo();
    useCase = new LogoutUseCase(refreshTokenRepository);
  });

  it("should revoke an active token and return ok", async () => {
    vi.mocked(refreshTokenRepository.findById).mockResolvedValue(activeToken);
    vi.mocked(refreshTokenRepository.revoke).mockResolvedValue();

    const result = await useCase.execute(activeToken.id);

    expect(result.ok).toBe(true);
    expect(refreshTokenRepository.revoke).toHaveBeenCalledWith(activeToken.id);
  });

  it("should return ok without calling revoke when token is already revoked (idempotent)", async () => {
    const revokedToken = activeToken.revoke();
    vi.mocked(refreshTokenRepository.findById).mockResolvedValue(revokedToken);

    const result = await useCase.execute(revokedToken.id);

    expect(result.ok).toBe(true);
    expect(refreshTokenRepository.revoke).not.toHaveBeenCalled();
  });

  it("should return error when token is not found", async () => {
    vi.mocked(refreshTokenRepository.findById).mockResolvedValue(null);

    const result = await useCase.execute("ghost-token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(401);
      expect(result.error.code).toBe("INVALID_TOKEN");
    }
  });
});
