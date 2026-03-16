import { describe, it, expect, vi, beforeEach } from "vitest";

import { RefreshToken } from "../../../../src/domain/entities/refresh_token.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import type { IRefreshTokenRepository } from "../../../../src/domain/repositories/refresh_token.repository.interface";
import type { IUserRepository } from "../../../../src/domain/repositories/user.repository.interface";
import { RefreshTokenUseCase } from "../../../../src/domain/use_cases/refresh_token.use_case";

const makeUserRepo = (): IUserRepository => ({
  findById: vi.fn(),
  findByEmail: vi.fn(),
  save: vi.fn(),
});

const makeTokenRepo = (): IRefreshTokenRepository => ({
  findById: vi.fn(),
  save: vi.fn(),
  revoke: vi.fn(),
});

const testUser = User.create({ email: "user@test.com", passwordHash: "hash", role: "user" });

const validToken = RefreshToken.create({
  id: "token-id-1",
  userId: testUser.id,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
});

describe("RefreshTokenUseCase", () => {
  let userRepository: IUserRepository;
  let refreshTokenRepository: IRefreshTokenRepository;
  let useCase: RefreshTokenUseCase;

  beforeEach(() => {
    userRepository = makeUserRepo();
    refreshTokenRepository = makeTokenRepo();
    useCase = new RefreshTokenUseCase(userRepository, refreshTokenRepository);
  });

  it("should return the user and revoke the old token on success", async () => {
    vi.mocked(refreshTokenRepository.findById).mockResolvedValue(validToken);
    vi.mocked(userRepository.findById).mockResolvedValue(testUser);
    vi.mocked(refreshTokenRepository.revoke).mockResolvedValue();

    const result = await useCase.execute({ tokenId: validToken.id, userId: testUser.id });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(testUser.id);
    expect(refreshTokenRepository.revoke).toHaveBeenCalledWith(validToken.id);
  });

  it("should return error when token is not found", async () => {
    vi.mocked(refreshTokenRepository.findById).mockResolvedValue(null);

    const result = await useCase.execute({ tokenId: "missing", userId: testUser.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.statusCode).toBe(401);
  });

  it("should return error when token userId does not match", async () => {
    vi.mocked(refreshTokenRepository.findById).mockResolvedValue(validToken);

    const result = await useCase.execute({ tokenId: validToken.id, userId: "different-user" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.statusCode).toBe(401);
  });

  it("should return error when token is revoked", async () => {
    const revokedToken = validToken.revoke();
    vi.mocked(refreshTokenRepository.findById).mockResolvedValue(revokedToken);

    const result = await useCase.execute({ tokenId: revokedToken.id, userId: testUser.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("revoked");
  });

  it("should return error when token is expired", async () => {
    const expiredToken = RefreshToken.create({
      id: "expired-id",
      userId: testUser.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    vi.mocked(refreshTokenRepository.findById).mockResolvedValue(expiredToken);

    const result = await useCase.execute({ tokenId: expiredToken.id, userId: testUser.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("expired");
  });
});
