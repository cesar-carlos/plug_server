import { describe, it, expect, vi, beforeEach } from "vitest";

import { User } from "../../../../src/domain/entities/user.entity";
import type { IRefreshTokenRepository } from "../../../../src/domain/repositories/refresh_token.repository.interface";
import type { IUserRepository } from "../../../../src/domain/repositories/user.repository.interface";
import { AdminSetUserStatusUseCase } from "../../../../src/domain/use_cases/admin_set_user_status.use_case";

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

describe("AdminSetUserStatusUseCase", () => {
  let userRepository: IUserRepository;
  let refreshTokenRepository: IRefreshTokenRepository;
  let useCase: AdminSetUserStatusUseCase;

  beforeEach(() => {
    userRepository = makeUserRepo();
    refreshTokenRepository = makeTokenRepo();
    useCase = new AdminSetUserStatusUseCase(userRepository, refreshTokenRepository);
  });

  it("blocks an active user and revokes refresh tokens", async () => {
    const active = User.create({
      email: "u@test.com",
      passwordHash: "h",
      role: "user",
      status: "active",
    });
    vi.mocked(userRepository.findById).mockResolvedValue(active);
    vi.mocked(userRepository.save).mockResolvedValue();
    vi.mocked(refreshTokenRepository.revokeAllForUser).mockResolvedValue();

    const result = await useCase.execute({ targetUserId: active.id, status: "blocked" });

    expect(result.ok).toBe(true);
    expect(refreshTokenRepository.revokeAllForUser).toHaveBeenCalledWith(active.id);
    expect(userRepository.save).toHaveBeenCalled();
    if (result.ok) expect(result.value.status).toBe("blocked");
  });

  it("unblocks a blocked user", async () => {
    const blocked = new User({
      id: "id-1",
      email: "u@test.com",
      passwordHash: "h",
      role: "user",
      status: "blocked",
      createdAt: new Date(),
    });
    vi.mocked(userRepository.findById).mockResolvedValue(blocked);
    vi.mocked(userRepository.save).mockResolvedValue();

    const result = await useCase.execute({ targetUserId: blocked.id, status: "active" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe("active");
    expect(refreshTokenRepository.revokeAllForUser).not.toHaveBeenCalled();
  });

  it("rejects active when user is not blocked", async () => {
    const active = User.create({
      email: "u@test.com",
      passwordHash: "h",
      role: "user",
      status: "active",
    });
    vi.mocked(userRepository.findById).mockResolvedValue(active);

    const result = await useCase.execute({ targetUserId: active.id, status: "active" });

    expect(result.ok).toBe(false);
    expect(userRepository.save).not.toHaveBeenCalled();
  });
});
