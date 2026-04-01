import { describe, it, expect, vi, beforeEach } from "vitest";

import { User } from "../../../../src/domain/entities/user.entity";
import type { IRefreshTokenRepository } from "../../../../src/domain/repositories/refresh_token.repository.interface";
import type { IUserRepository } from "../../../../src/domain/repositories/user.repository.interface";
import { RefreshTokenUseCase } from "../../../../src/domain/use_cases/refresh_token.use_case";

const makeUserRepo = (): IUserRepository => ({
  findById: vi.fn(),
  findByEmail: vi.fn(),
  findByCelular: vi.fn(),
  save: vi.fn(),
});

const makeTokenRepo = (): IRefreshTokenRepository => ({
  findById: vi.fn(),
  save: vi.fn(),
  revoke: vi.fn(),
  revokeAllForUser: vi.fn(),
  consume: vi.fn(),
});

const testUser = User.create({
  email: "user@test.com",
  passwordHash: "hash",
  role: "user",
  status: "active",
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
    vi.mocked(refreshTokenRepository.consume).mockResolvedValue("consumed");
    vi.mocked(userRepository.findById).mockResolvedValue(testUser);

    const result = await useCase.execute({ tokenId: "token-id-1", userId: testUser.id });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(testUser.id);
    expect(refreshTokenRepository.consume).toHaveBeenCalledWith(
      "token-id-1",
      testUser.id,
      expect.any(Date),
    );
  });

  it("should return error when token is not found", async () => {
    vi.mocked(refreshTokenRepository.consume).mockResolvedValue("not_found");

    const result = await useCase.execute({ tokenId: "missing", userId: testUser.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.statusCode).toBe(401);
  });

  it("should return error when token userId does not match", async () => {
    vi.mocked(refreshTokenRepository.consume).mockResolvedValue("user_mismatch");

    const result = await useCase.execute({ tokenId: "token-id-1", userId: "different-user" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.statusCode).toBe(401);
  });

  it("should return error when token is revoked", async () => {
    vi.mocked(refreshTokenRepository.consume).mockResolvedValue("revoked");

    const result = await useCase.execute({ tokenId: "token-id-1", userId: testUser.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("revoked");
  });

  it("should return error when token is expired", async () => {
    vi.mocked(refreshTokenRepository.consume).mockResolvedValue("expired");

    const result = await useCase.execute({ tokenId: "expired-id", userId: testUser.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("expired");
  });

  it("should return forbidden when user is blocked", async () => {
    const blocked = User.create({
      email: "blocked@test.com",
      passwordHash: "hash",
      role: "user",
      status: "blocked",
    });
    vi.mocked(refreshTokenRepository.consume).mockResolvedValue("consumed");
    vi.mocked(userRepository.findById).mockResolvedValue(blocked);

    const result = await useCase.execute({ tokenId: "token-id-1", userId: blocked.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(403);
      expect(result.error.message).toBe("Account is blocked");
    }
  });
});
