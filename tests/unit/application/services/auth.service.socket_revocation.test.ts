import { afterEach, describe, expect, it, vi } from "vitest";

import { UserAccountService } from "../../../../src/application/services/user_account.service";
import { registerAgentSocketControlHandler } from "../../../../src/application/services/agent_socket_control_sink";
import { registerConsumerSocketControlHandler } from "../../../../src/application/services/consumer_socket_control_sink";
import { User } from "../../../../src/domain/entities/user.entity";

const makeService = (
  adminSetUserStatusResult: unknown,
  agentAccessService: { invalidateAccessCacheForUser: ReturnType<typeof vi.fn> } = {
    invalidateAccessCacheForUser: vi.fn(),
  },
): UserAccountService =>
  new UserAccountService(
    { execute: vi.fn().mockResolvedValue(adminSetUserStatusResult) } as never,
    { execute: vi.fn() } as never,
    agentAccessService as never,
    {
      invalidateSnapshotCache: vi.fn(),
      getMeProfile: vi.fn(),
    } as never,
  );

describe("AuthService socket revocation", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  });

  it("disconnects both consumer and agent sockets when a user is blocked", async () => {
    const blockedUser = new User({
      id: "user-blocked-1",
      email: "blocked@example.com",
      passwordHash: "hash",
      role: "user",
      status: "blocked",
      createdAt: new Date(),
    });
    const disconnectAgent = vi.fn().mockResolvedValue(undefined);
    const disconnectConsumer = vi.fn().mockResolvedValue(undefined);
    const invalidateUserSnapshots = vi.fn().mockResolvedValue(undefined);
    const agentAccessService = { invalidateAccessCacheForUser: vi.fn() };
    disposers.push(registerAgentSocketControlHandler({ disconnectPrincipal: disconnectAgent }));
    disposers.push(
      registerConsumerSocketControlHandler({
        disconnectPrincipal: disconnectConsumer,
        revokeClientAccess: vi.fn(),
        grantClientAccess: vi.fn(),
        invalidateUserAccessSnapshot: invalidateUserSnapshots,
      }),
    );

    const service = makeService({ ok: true, value: blockedUser }, agentAccessService);
    const result = await service.adminSetUserStatus({
      adminUserId: "admin-1",
      targetUserId: blockedUser.id,
      status: "blocked",
    });

    expect(result.ok).toBe(true);
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
});
