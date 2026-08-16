import { afterEach, describe, expect, it, vi } from "vitest";

import { UserAccountService } from "../../../../src/application/services/user_account.service";
import { registerAgentSocketControlHandler } from "../../../../src/application/services/agent_socket_control_sink";
import { registerConsumerSocketControlHandler } from "../../../../src/application/services/consumer_socket_control_sink";
import { User } from "../../../../src/domain/entities/user.entity";
import { unauthorized } from "../../../../src/shared/errors/http_errors";
import { err, ok } from "../../../../src/shared/errors/result";
import type { JwtAccessPayload } from "../../../../src/shared/utils/jwt";

const makeUser = (status: "active" | "blocked" = "active"): User =>
  User.create({
    id: "user-blocked-1",
    email: "blocked@example.com",
    passwordHash: "hash",
    role: "user",
    status,
  });

const makeAccessPayload = (user: User): JwtAccessPayload => ({
  sub: user.id,
  email: user.email,
  role: user.role,
  principal_type: "user",
  credentials_version: user.credentialsUpdatedAt.getTime(),
  tokenType: "access",
});

const makeService = (
  adminSetUserStatusResult: unknown,
  agentAccessService: { invalidateAccessCacheForUser: ReturnType<typeof vi.fn> } = {
    invalidateAccessCacheForUser: vi.fn(),
  },
  authService: {
    invalidateSnapshotCache: ReturnType<typeof vi.fn>;
    getMeProfile: ReturnType<typeof vi.fn>;
  } = {
    invalidateSnapshotCache: vi.fn(),
    getMeProfile: vi.fn(),
  },
  updateMyCelularResult: unknown = ok(makeUser()),
): UserAccountService =>
  new UserAccountService(
    { execute: vi.fn().mockResolvedValue(adminSetUserStatusResult) } as never,
    { execute: vi.fn().mockResolvedValue(updateMyCelularResult) } as never,
    agentAccessService as never,
    authService,
  );

describe("UserAccountService", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  });

  it("disconnects both consumer and agent sockets when a user is blocked", async () => {
    const blockedUser = makeUser("blocked");
    const disconnectAgent = vi.fn().mockResolvedValue(undefined);
    const disconnectConsumer = vi.fn().mockResolvedValue(undefined);
    const invalidateUserSnapshots = vi.fn().mockResolvedValue(undefined);
    const agentAccessService = { invalidateAccessCacheForUser: vi.fn() };
    const authService = {
      invalidateSnapshotCache: vi.fn(),
      getMeProfile: vi.fn(),
    };
    disposers.push(registerAgentSocketControlHandler({ disconnectPrincipal: disconnectAgent }));
    disposers.push(
      registerConsumerSocketControlHandler({
        disconnectPrincipal: disconnectConsumer,
        revokeClientAccess: vi.fn(),
        grantClientAccess: vi.fn(),
        invalidateUserAccessSnapshot: invalidateUserSnapshots,
      }),
    );

    const service = makeService(ok(blockedUser), agentAccessService, authService);
    const result = await service.adminSetUserStatus({
      adminUserId: "admin-1",
      targetUserId: blockedUser.id,
      status: "blocked",
    });

    expect(result.ok).toBe(true);
    expect(authService.invalidateSnapshotCache).toHaveBeenCalledWith(blockedUser.id);
    expect(agentAccessService.invalidateAccessCacheForUser).toHaveBeenCalledWith(blockedUser.id);
    expect(disconnectConsumer).toHaveBeenCalledWith({
      principalType: "user",
      principalId: blockedUser.id,
      reason: "account_blocked",
    });
    expect(disconnectAgent).toHaveBeenCalledWith({
      userId: blockedUser.id,
      reason: "account_blocked",
    });
    expect(invalidateUserSnapshots).toHaveBeenCalledWith({ userId: blockedUser.id });
  });

  it("does not revoke sockets when the status change is not a block", async () => {
    const activeUser = makeUser("active");
    const disconnectAgent = vi.fn();
    const disconnectConsumer = vi.fn();
    const agentAccessService = { invalidateAccessCacheForUser: vi.fn() };
    const authService = {
      invalidateSnapshotCache: vi.fn(),
      getMeProfile: vi.fn(),
    };
    disposers.push(registerAgentSocketControlHandler({ disconnectPrincipal: disconnectAgent }));
    disposers.push(
      registerConsumerSocketControlHandler({
        disconnectPrincipal: disconnectConsumer,
        revokeClientAccess: vi.fn(),
        grantClientAccess: vi.fn(),
        invalidateUserAccessSnapshot: vi.fn(),
      }),
    );

    const service = makeService(ok(activeUser), agentAccessService, authService);
    const result = await service.adminSetUserStatus({
      adminUserId: "admin-1",
      targetUserId: activeUser.id,
      status: "active",
    });

    expect(result.ok).toBe(true);
    expect(authService.invalidateSnapshotCache).not.toHaveBeenCalled();
    expect(agentAccessService.invalidateAccessCacheForUser).not.toHaveBeenCalled();
    expect(disconnectConsumer).not.toHaveBeenCalled();
    expect(disconnectAgent).not.toHaveBeenCalled();
  });

  it("returns the auth profile after a successful celular update", async () => {
    const user = makeUser("active");
    const updated = User.create({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      role: user.role,
      status: user.status,
      celular: "+5511987654321",
    });
    const profile = {
      id: updated.id,
      sub: updated.id,
      email: updated.email,
      role: updated.role,
      status: updated.status,
      celular: updated.celular,
    };
    const authService = {
      invalidateSnapshotCache: vi.fn(),
      getMeProfile: vi.fn().mockResolvedValue(ok(profile)),
    };
    const service = makeService(ok(user), undefined, authService, ok(updated));
    const jwtUser = makeAccessPayload(user);

    const result = await service.updateMyCelular(jwtUser, { celular: "+5511987654321" });

    expect(result.ok).toBe(true);
    expect(authService.getMeProfile).toHaveBeenCalledWith(jwtUser, updated);
    if (result.ok) {
      expect(result.value.celular).toBe("+5511987654321");
    }
  });

  it("propagates celular update failures without calling getMeProfile", async () => {
    const user = makeUser("active");
    const authService = {
      invalidateSnapshotCache: vi.fn(),
      getMeProfile: vi.fn(),
    };
    const service = makeService(
      ok(user),
      undefined,
      authService,
      err(unauthorized("Invalid credentials")),
    );

    const result = await service.updateMyCelular(makeAccessPayload(user), { celular: null });

    expect(result.ok).toBe(false);
    expect(authService.getMeProfile).not.toHaveBeenCalled();
  });
});
