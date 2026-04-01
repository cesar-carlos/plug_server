import { describe, it, expect, vi, beforeEach } from "vitest";

import { User } from "../../../../src/domain/entities/user.entity";
import type { IPasswordHasher } from "../../../../src/domain/ports/password_hasher.port";
import type { IUserRepository } from "../../../../src/domain/repositories/user.repository.interface";
import { LoginUseCase } from "../../../../src/domain/use_cases/login.use_case";

const makeRepo = (): IUserRepository => ({
  findById: vi.fn(),
  findByEmail: vi.fn(),
  findByCelular: vi.fn(),
  save: vi.fn(),
});

const makeHasher = (): IPasswordHasher => ({
  hash: vi.fn(),
  compare: vi.fn(),
});

const existingUser = User.create({
  email: "user@test.com",
  passwordHash: "$hashed$",
  role: "user",
  status: "active",
});

describe("LoginUseCase", () => {
  let userRepository: IUserRepository;
  let passwordHasher: IPasswordHasher;
  let useCase: LoginUseCase;

  beforeEach(() => {
    userRepository = makeRepo();
    passwordHasher = makeHasher();
    useCase = new LoginUseCase(userRepository, passwordHasher);
  });

  it("should return the user when credentials are valid", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(existingUser);
    vi.mocked(passwordHasher.compare).mockResolvedValue(true);

    const result = await useCase.execute({ email: "user@test.com", plainPassword: "Password1" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(existingUser.id);
  });

  it("should return unauthorized when user is not found", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);

    const result = await useCase.execute({ email: "ghost@test.com", plainPassword: "Password1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(401);
      expect(result.error.message).toBe("Invalid email or password");
    }
  });

  it("should return unauthorized when password does not match", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(existingUser);
    vi.mocked(passwordHasher.compare).mockResolvedValue(false);

    const result = await useCase.execute({ email: "user@test.com", plainPassword: "WrongPass1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(401);
      expect(result.error.message).toBe("Invalid email or password");
    }
  });

  it("should return forbidden when account is pending approval", async () => {
    const pendingUser = User.create({
      email: "pending@test.com",
      passwordHash: "$hashed$",
      role: "user",
      status: "pending",
    });
    vi.mocked(userRepository.findByEmail).mockResolvedValue(pendingUser);
    vi.mocked(passwordHasher.compare).mockResolvedValue(true);

    const result = await useCase.execute({ email: "pending@test.com", plainPassword: "Password1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(403);
      expect(result.error.message).toBe("Account is pending admin approval");
    }
  });

  it("should return forbidden when registration was rejected", async () => {
    const rejectedUser = User.create({
      email: "rej@test.com",
      passwordHash: "$hashed$",
      role: "user",
      status: "rejected",
    });
    vi.mocked(userRepository.findByEmail).mockResolvedValue(rejectedUser);
    vi.mocked(passwordHasher.compare).mockResolvedValue(true);

    const result = await useCase.execute({ email: "rej@test.com", plainPassword: "Password1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(403);
      expect(result.error.message).toBe("Account registration was rejected");
    }
  });

  it("should return forbidden when account is blocked", async () => {
    const blockedUser = User.create({
      email: "blocked@test.com",
      passwordHash: "$hashed$",
      role: "user",
      status: "blocked",
    });
    vi.mocked(userRepository.findByEmail).mockResolvedValue(blockedUser);
    vi.mocked(passwordHasher.compare).mockResolvedValue(true);

    const result = await useCase.execute({ email: "blocked@test.com", plainPassword: "Password1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(403);
      expect(result.error.message).toBe("Account is blocked");
    }
  });
});
