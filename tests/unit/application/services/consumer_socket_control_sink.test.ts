import { describe, expect, it, vi } from "vitest";

import {
  disconnectConsumerPrincipalSockets,
  grantConsumerClientAccessRooms,
  invalidateConsumerAgentAccessSnapshotsByAgentId,
  invalidateConsumerClientAgentAccessSnapshots,
  invalidateConsumerUserAccessSnapshots,
  registerConsumerSocketControlHandler,
  revokeConsumerClientAccessSockets,
} from "../../../../src/application/services/consumer_socket_control_sink";

describe("consumer_socket_control_sink", () => {
  it("fans out to all registered handlers and disposer removes only its own handler", async () => {
    const first = {
      disconnectPrincipal: vi.fn().mockResolvedValue(undefined),
      revokeClientAccess: vi.fn().mockResolvedValue(undefined),
      grantClientAccess: vi.fn().mockResolvedValue(undefined),
      invalidateClientAgentAccessSnapshot: vi.fn().mockResolvedValue(undefined),
      invalidateAgentAccessSnapshot: vi.fn().mockResolvedValue(undefined),
      invalidateUserAccessSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const second = {
      disconnectPrincipal: vi.fn().mockResolvedValue(undefined),
      revokeClientAccess: vi.fn().mockResolvedValue(undefined),
      grantClientAccess: vi.fn().mockResolvedValue(undefined),
      invalidateClientAgentAccessSnapshot: vi.fn().mockResolvedValue(undefined),
      invalidateAgentAccessSnapshot: vi.fn().mockResolvedValue(undefined),
      invalidateUserAccessSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const disposeFirst = registerConsumerSocketControlHandler(first);
    const disposeSecond = registerConsumerSocketControlHandler(second);

    await disconnectConsumerPrincipalSockets({
      principalType: "client",
      principalId: "client-1",
      reason: "account_blocked",
    });
    await grantConsumerClientAccessRooms({ clientId: "client-1", agentId: "agent-1" });
    await invalidateConsumerClientAgentAccessSnapshots({
      clientId: "client-1",
      agentId: "agent-1",
    });
    await invalidateConsumerAgentAccessSnapshotsByAgentId({ agentId: "agent-1" });
    await invalidateConsumerUserAccessSnapshots({ userId: "user-1" });

    expect(first.disconnectPrincipal).toHaveBeenCalledTimes(1);
    expect(second.disconnectPrincipal).toHaveBeenCalledTimes(1);
    expect(first.grantClientAccess).toHaveBeenCalledTimes(1);
    expect(second.grantClientAccess).toHaveBeenCalledTimes(1);
    expect(first.invalidateClientAgentAccessSnapshot).toHaveBeenCalledTimes(1);
    expect(second.invalidateClientAgentAccessSnapshot).toHaveBeenCalledTimes(1);
    expect(first.invalidateAgentAccessSnapshot).toHaveBeenCalledTimes(1);
    expect(second.invalidateAgentAccessSnapshot).toHaveBeenCalledTimes(1);
    expect(first.invalidateUserAccessSnapshot).toHaveBeenCalledTimes(1);
    expect(second.invalidateUserAccessSnapshot).toHaveBeenCalledTimes(1);

    disposeFirst();
    await revokeConsumerClientAccessSockets({
      clientId: "client-1",
      agentId: "agent-1",
      reason: "client_access_revoked",
    });

    expect(first.revokeClientAccess).not.toHaveBeenCalled();
    expect(second.revokeClientAccess).toHaveBeenCalledTimes(1);

    disposeSecond();
  });
});
