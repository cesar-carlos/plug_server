import { describe, it, expect, vi, beforeEach } from "vitest";

import type { IRegistrationApprovalTokenRepository } from "../../../../src/domain/repositories/registration_approval_token.repository.interface";
import type { IUserRepository } from "../../../../src/domain/repositories/user.repository.interface";
import { RegisterUseCase } from "../../../../src/domain/use_cases/register.use_case";
import { generateOpaqueRegistrationToken } from "../../../../src/shared/utils/registration_token";

const makeUserRepo = (): IUserRepository => ({
  findById: vi.fn(),
  findByEmail: vi.fn(),
  findByCelular: vi.fn(),
  save: vi.fn(),
});

const makeTokenRepo = (): IRegistrationApprovalTokenRepository => ({
  save: vi.fn(),
  findById: vi.fn(),
  deleteById: vi.fn(),
});

const expiresAt = new Date(Date.now() + 86_400_000);

describe("RegisterUseCase", () => {
  let userRepository: IUserRepository;
  let approvalTokenRepository: IRegistrationApprovalTokenRepository;
  let useCase: RegisterUseCase;

  beforeEach(() => {
    userRepository = makeUserRepo();
    approvalTokenRepository = makeTokenRepo();
    useCase = new RegisterUseCase(userRepository, approvalTokenRepository);
    vi.mocked(userRepository.findByCelular).mockResolvedValue(null);
  });

  it("should create a pending user and approval token when email is not taken", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(userRepository.save).mockResolvedValue();
    vi.mocked(approvalTokenRepository.save).mockResolvedValue();

    const result = await useCase.execute({
      email: "user@test.com",
      passwordHash: "hashed",
      approvalTokenExpiresAt: expiresAt,
      approvalTokenId: generateOpaqueRegistrationToken(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.user.email).toBe("user@test.com");
      expect(result.value.user.role).toBe("user");
      expect(result.value.user.status).toBe("pending");
      expect(result.value.user.celular).toBeUndefined();
      expect(result.value.user.id).toBeDefined();
      expect(result.value.approvalToken.userId).toBe(result.value.user.id);
      expect(result.value.approvalToken.expiresAt).toEqual(expiresAt);
    }
    expect(userRepository.save).toHaveBeenCalledOnce();
    expect(approvalTokenRepository.save).toHaveBeenCalledOnce();
  });

  it("should return conflict when celular is already registered", async () => {
    const { User } = await import("../../../../src/domain/entities/user.entity");
    const other = User.create({
      email: "other@test.com",
      passwordHash: "hash",
      celular: "+5511987654321",
      role: "user",
      status: "pending",
    });
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(userRepository.findByCelular).mockResolvedValue(other);

    const result = await useCase.execute({
      email: "new@test.com",
      passwordHash: "hashed",
      celular: "+5511987654321",
      approvalTokenExpiresAt: expiresAt,
      approvalTokenId: generateOpaqueRegistrationToken(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(409);
      expect(result.error.message).toBe("Phone number already in use");
    }
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it("should persist optional celular when provided", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(userRepository.save).mockResolvedValue();
    vi.mocked(approvalTokenRepository.save).mockResolvedValue();

    const result = await useCase.execute({
      email: "mobile@test.com",
      passwordHash: "hashed",
      celular: "+5511987654321",
      approvalTokenExpiresAt: expiresAt,
      approvalTokenId: generateOpaqueRegistrationToken(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.user.celular).toBe("+5511987654321");
  });

  it("should accept a custom role", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(userRepository.save).mockResolvedValue();
    vi.mocked(approvalTokenRepository.save).mockResolvedValue();

    const result = await useCase.execute({
      email: "admin@test.com",
      passwordHash: "hash",
      role: "admin",
      approvalTokenExpiresAt: expiresAt,
      approvalTokenId: generateOpaqueRegistrationToken(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.user.role).toBe("admin");
  });

  it("should return conflict error when email is already taken", async () => {
    const { User } = await import("../../../../src/domain/entities/user.entity");
    const existingUser = User.create({
      email: "user@test.com",
      passwordHash: "hash",
      role: "user",
      status: "active",
    });
    vi.mocked(userRepository.findByEmail).mockResolvedValue(existingUser);

    const result = await useCase.execute({
      email: "user@test.com",
      passwordHash: "hash2",
      approvalTokenExpiresAt: expiresAt,
      approvalTokenId: generateOpaqueRegistrationToken(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.statusCode).toBe(409);
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.message).toBe("Email already in use");
    }
    expect(userRepository.save).not.toHaveBeenCalled();
    expect(approvalTokenRepository.save).not.toHaveBeenCalled();
  });
});
