import { describe, it, expect, vi, beforeEach } from "vitest";

import type { IUserRepository } from "../../../../src/domain/repositories/user.repository.interface";
import { RegisterUseCase } from "../../../../src/domain/use_cases/register.use_case";

const makeRepo = (): IUserRepository => ({
  findById: vi.fn(),
  findByEmail: vi.fn(),
  save: vi.fn(),
});

describe("RegisterUseCase", () => {
  let userRepository: IUserRepository;
  let useCase: RegisterUseCase;

  beforeEach(() => {
    userRepository = makeRepo();
    useCase = new RegisterUseCase(userRepository);
  });

  it("should create and return a new user when email is not taken", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(userRepository.save).mockResolvedValue();

    const result = await useCase.execute({ email: "user@test.com", passwordHash: "hashed" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email).toBe("user@test.com");
      expect(result.value.role).toBe("user");
      expect(result.value.id).toBeDefined();
    }
    expect(userRepository.save).toHaveBeenCalledOnce();
  });

  it("should accept a custom role", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(userRepository.save).mockResolvedValue();

    const result = await useCase.execute({ email: "admin@test.com", passwordHash: "hash", role: "admin" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.role).toBe("admin");
  });

  it("should return conflict error when email is already taken", async () => {
    const { User } = await import("../../../../src/domain/entities/user.entity");
    const existingUser = User.create({ email: "user@test.com", passwordHash: "hash", role: "user" });
    vi.mocked(userRepository.findByEmail).mockResolvedValue(existingUser);

    const result = await useCase.execute({ email: "user@test.com", passwordHash: "hash2" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(409);
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.message).toBe("Email already in use");
    }
    expect(userRepository.save).not.toHaveBeenCalled();
  });
});
