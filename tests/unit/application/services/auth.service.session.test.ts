import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../../../../src/application/services/auth.service";
import { User } from "../../../../src/domain/entities/user.entity";
import { unauthorized } from "../../../../src/shared/errors/http_errors";
import { err, ok } from "../../../../src/shared/errors/result";
import { signRefreshToken } from "../../../../src/shared/utils/jwt";

const makeUser = (
  overrides: {
    readonly id?: string;
    readonly email?: string;
    readonly celular?: string;
    readonly status?: "pending" | "active" | "rejected" | "blocked";
    readonly credentialsUpdatedAt?: Date;
  } = {},
): User =>
  User.create({
    id: overrides.id ?? "user-1",
    email: overrides.email ?? "user@test.com",
    passwordHash: "hashed",
    role: "user",
    status: overrides.status ?? "active",
    ...(overrides.celular !== undefined ? { celular: overrides.celular } : {}),
    ...(overrides.credentialsUpdatedAt !== undefined
      ? { credentialsUpdatedAt: overrides.credentialsUpdatedAt }
      : {}),
  });

const makeService = (): {
  readonly service: AuthService;
  readonly loginUseCase: { execute: ReturnType<typeof vi.fn> };
  readonly changePasswordUseCase: { execute: ReturnType<typeof vi.fn> };
  readonly refreshTokenUseCase: { execute: ReturnType<typeof vi.fn> };
  readonly logoutUseCase: { execute: ReturnType<typeof vi.fn> };
  readonly refreshTokenRepository: {
    save: ReturnType<typeof vi.fn>;
    revokeAllForUser: ReturnType<typeof vi.fn>;
  };
  readonly userRepository: {
    findById: ReturnType<typeof vi.fn>;
    findActiveSnapshotById: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  readonly agentAccessService: { assertAgentLoginAllowed: ReturnType<typeof vi.fn> };
} => {
  const loginUseCase = { execute: vi.fn() };
  const changePasswordUseCase = { execute: vi.fn() };
  const refreshTokenUseCase = { execute: vi.fn() };
  const logoutUseCase = { execute: vi.fn() };
  const refreshTokenRepository = {
    save: vi.fn().mockResolvedValue(undefined),
    revokeAllForUser: vi.fn().mockResolvedValue(undefined),
  };
  const userRepository = {
    findById: vi.fn(),
    findActiveSnapshotById: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const agentAccessService = { assertAgentLoginAllowed: vi.fn() };
  return {
    service: new AuthService(
      loginUseCase as never,
      changePasswordUseCase as never,
      refreshTokenUseCase as never,
      logoutUseCase as never,
      refreshTokenRepository as never,
      userRepository as never,
      agentAccessService as never,
    ),
    loginUseCase,
    changePasswordUseCase,
    refreshTokenUseCase,
    logoutUseCase,
    refreshTokenRepository,
    userRepository,
    agentAccessService,
  };
};

describe("AuthService session flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns login tokens for an authenticated user", async () => {
    const { service, loginUseCase, refreshTokenRepository } = makeService();
    const user = makeUser();
    loginUseCase.execute.mockResolvedValue(ok(user));

    const result = await service.login({ email: user.email, password: "secret" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.user).toEqual({ id: user.id, email: user.email, role: user.role });
    expect(result.value.accessToken).toEqual(expect.any(String));
    expect(result.value.refreshToken).toEqual(expect.any(String));
    expect(refreshTokenRepository.save).toHaveBeenCalledOnce();
  });

  it("propagates login use-case failures", async () => {
    const { service, loginUseCase, refreshTokenRepository } = makeService();
    loginUseCase.execute.mockResolvedValue(err(unauthorized("Invalid credentials")));

    const result = await service.login({ email: "missing@test.com", password: "secret" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHORIZED");
    }
    expect(refreshTokenRepository.save).not.toHaveBeenCalled();
  });

  it("issues an agent session when login and agent access both succeed", async () => {
    const { service, loginUseCase, agentAccessService, refreshTokenRepository } = makeService();
    const user = makeUser();
    loginUseCase.execute.mockResolvedValue(ok(user));
    agentAccessService.assertAgentLoginAllowed.mockResolvedValue(ok(undefined));

    const result = await service.agentLogin({
      email: user.email,
      password: "secret",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.user).toEqual({
      id: user.id,
      email: user.email,
      role: "agent",
      agentId: "agent-1",
    });
    expect(refreshTokenRepository.save).toHaveBeenCalledOnce();
  });

  it("does not issue tokens when agent-login credentials fail", async () => {
    const { service, loginUseCase, agentAccessService } = makeService();
    loginUseCase.execute.mockResolvedValue(err(unauthorized("Invalid credentials")));

    const result = await service.agentLogin({
      email: "user@test.com",
      password: "wrong",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(agentAccessService.assertAgentLoginAllowed).not.toHaveBeenCalled();
  });

  it("does not issue tokens when agent login is not allowed", async () => {
    const { service, loginUseCase, agentAccessService, refreshTokenRepository } = makeService();
    loginUseCase.execute.mockResolvedValue(ok(makeUser()));
    agentAccessService.assertAgentLoginAllowed.mockResolvedValue(
      err(unauthorized("Agent access denied")),
    );

    const result = await service.agentLogin({
      email: "user@test.com",
      password: "secret",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(refreshTokenRepository.save).not.toHaveBeenCalled();
  });

  it("propagates change-password use-case failures", async () => {
    const { service, changePasswordUseCase, userRepository } = makeService();
    changePasswordUseCase.execute.mockResolvedValue(err(unauthorized("Invalid credentials")));

    const result = await service.changePassword({
      userId: "user-1",
      currentPassword: "old",
      newPassword: "new-password",
    });

    expect(result.ok).toBe(false);
    expect(userRepository.findById).not.toHaveBeenCalled();
  });

  it("returns not found when the user disappears after a successful password change", async () => {
    const { service, changePasswordUseCase, userRepository, refreshTokenRepository } =
      makeService();
    changePasswordUseCase.execute.mockResolvedValue(ok(undefined));
    userRepository.findById.mockResolvedValue(null);

    const result = await service.changePassword({
      userId: "user-1",
      currentPassword: "old",
      newPassword: "new-password",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
    expect(refreshTokenRepository.revokeAllForUser).not.toHaveBeenCalled();
  });

  it("bumps credentials and revokes refresh tokens after a password change", async () => {
    const { service, changePasswordUseCase, userRepository, refreshTokenRepository } =
      makeService();
    const user = makeUser({ celular: "+5511999999999" });
    changePasswordUseCase.execute.mockResolvedValue(ok(undefined));
    userRepository.findById.mockResolvedValue(user);

    const result = await service.changePassword({
      userId: user.id,
      currentPassword: "old",
      newPassword: "new-password",
    });

    expect(result.ok).toBe(true);
    expect(userRepository.save).toHaveBeenCalledOnce();
    const saved = userRepository.save.mock.calls[0]?.[0] as User;
    expect(saved.celular).toBe("+5511999999999");
    expect(saved.credentialsUpdatedAt.getTime()).toBeGreaterThanOrEqual(
      user.credentialsUpdatedAt.getTime(),
    );
    expect(refreshTokenRepository.revokeAllForUser).toHaveBeenCalledWith(user.id);
  });

  it("preserves users without celular when bumping credentials after a password change", async () => {
    const { service, changePasswordUseCase, userRepository } = makeService();
    const user = makeUser();
    changePasswordUseCase.execute.mockResolvedValue(ok(undefined));
    userRepository.findById.mockResolvedValue(user);

    const result = await service.changePassword({
      userId: user.id,
      currentPassword: "old",
      newPassword: "new-password",
    });

    expect(result.ok).toBe(true);
    const saved = userRepository.save.mock.calls[0]?.[0] as User;
    expect(saved.celular).toBeUndefined();
  });

  it("returns the refresh-token verification error for an invalid token", async () => {
    const { service, refreshTokenUseCase } = makeService();

    const result = await service.refresh("not-a-jwt");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOKEN");
    }
    expect(refreshTokenUseCase.execute).not.toHaveBeenCalled();
  });

  it("propagates refresh use-case failures", async () => {
    const { service, refreshTokenUseCase } = makeService();
    const user = makeUser();
    const raw = signRefreshToken({
      sub: user.id,
      jti: "refresh-jti",
      principal_type: "user",
      tokenType: "refresh",
    });
    refreshTokenUseCase.execute.mockResolvedValue(err(unauthorized("Invalid refresh token")));

    const result = await service.refresh(raw);

    expect(result.ok).toBe(false);
    expect(refreshTokenUseCase.execute).toHaveBeenCalledWith({
      tokenId: "refresh-jti",
      userId: user.id,
    });
  });

  it("rotates a user refresh token without an agent claim", async () => {
    const { service, refreshTokenUseCase, refreshTokenRepository } = makeService();
    const user = makeUser();
    const raw = signRefreshToken({
      sub: user.id,
      jti: "refresh-jti",
      principal_type: "user",
      tokenType: "refresh",
    });
    refreshTokenUseCase.execute.mockResolvedValue(ok(user));

    const result = await service.refresh(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.accessToken).toEqual(expect.any(String));
    expect(refreshTokenRepository.save).toHaveBeenCalledOnce();
  });

  it("rotates an agent refresh token and keeps the agent claim", async () => {
    const { service, refreshTokenUseCase } = makeService();
    const user = makeUser();
    const raw = signRefreshToken({
      sub: user.id,
      jti: "agent-refresh-jti",
      principal_type: "user",
      tokenType: "refresh",
      agent_id: "agent-9",
    });
    refreshTokenUseCase.execute.mockResolvedValue(ok(user));

    const result = await service.refresh(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.accessToken).toEqual(expect.any(String));
    expect(result.value.refreshToken).toEqual(expect.any(String));
  });

  it("succeeds silently when logout receives an invalid refresh token", async () => {
    const { service, logoutUseCase } = makeService();

    const result = await service.logout("not-a-jwt");

    expect(result.ok).toBe(true);
    expect(logoutUseCase.execute).not.toHaveBeenCalled();
  });

  it("revokes the refresh token jti on logout", async () => {
    const { service, logoutUseCase } = makeService();
    logoutUseCase.execute.mockResolvedValue(ok(undefined));
    const raw = signRefreshToken({
      sub: "user-1",
      jti: "logout-jti",
      principal_type: "user",
      tokenType: "refresh",
    });

    const result = await service.logout(raw);

    expect(result.ok).toBe(true);
    expect(logoutUseCase.execute).toHaveBeenCalledWith("logout-jti");
  });
});
