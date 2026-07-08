import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Namespace } from "socket.io";

vi.mock(
  "../../../../../src/presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile",
  () => ({
    invalidateApprovedAgentIdsCache: vi.fn(),
  }),
);

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  invalidateLocalAgentAccessSnapshotsByAgentId: vi.fn(),
  invalidateLocalClientAgentAccessSnapshot: vi.fn(),
  invalidateLocalUserAccessSnapshots: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/consumer_identity_rooms", () => ({
  buildConsumerClientAgentRoom: vi.fn(
    ({ clientId, agentId }: { clientId: string; agentId: string }) =>
      `consumer:client-agent:${clientId}:${agentId}`,
  ),
  buildConsumerClientRoom: vi.fn((clientId: string) => `client:${clientId}`),
  joinConsumerClientAgentRoom: vi.fn(async () => undefined),
}));

import { buildConsumerSocketControlHandlers } from "../../../../../src/presentation/socket/hub/build_consumer_socket_control_handlers";
import { invalidateApprovedAgentIdsCache } from "../../../../../src/presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";
import {
  invalidateLocalAgentAccessSnapshotsByAgentId,
  invalidateLocalClientAgentAccessSnapshot,
  invalidateLocalUserAccessSnapshots,
} from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";

const mockedInvalidateApprovedCache = vi.mocked(invalidateApprovedAgentIdsCache);
const mockedInvalidateLocalByAgent = vi.mocked(invalidateLocalAgentAccessSnapshotsByAgentId);
const mockedInvalidateLocalClientAgent = vi.mocked(invalidateLocalClientAgentAccessSnapshot);
const mockedInvalidateLocalUser = vi.mocked(invalidateLocalUserAccessSnapshots);

describe("buildConsumerSocketControlHandlers", () => {
  const disconnectConsumerSocketsInRoom = vi.fn(async () => 0);
  const clientProfileRecipientsCacheByAgentId = { delete: vi.fn() };
  const consumersNsp = {
    in: vi.fn(),
    sockets: { get: vi.fn() },
  } as unknown as Namespace;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates approved-agent cache on grant and revoke", async () => {
    const fetchSockets = vi.fn(async () => []);
    (consumersNsp.in as ReturnType<typeof vi.fn>).mockReturnValue({ fetchSockets });

    const handlers = buildConsumerSocketControlHandlers({
      consumersNsp,
      clientProfileRecipientsCacheByAgentId,
      disconnectConsumerSocketsInRoom,
    });

    await handlers.grantClientAccess({ clientId: "client-1", agentId: "agent-1" });
    await handlers.revokeClientAccess({
      clientId: "client-1",
      agentId: "agent-1",
      reason: "client_access_revoked",
    });

    expect(mockedInvalidateApprovedCache).toHaveBeenCalledWith("client-1");
    expect(mockedInvalidateApprovedCache).toHaveBeenCalledTimes(2);
  });

  it("invalidates agent access snapshots via local reverse index without fetchSockets", async () => {
    const handlers = buildConsumerSocketControlHandlers({
      consumersNsp,
      clientProfileRecipientsCacheByAgentId,
      disconnectConsumerSocketsInRoom,
    });

    await handlers.invalidateAgentAccessSnapshot?.({ agentId: "agent-9" });
    await handlers.invalidateClientAgentAccessSnapshot?.({
      clientId: "client-1",
      agentId: "agent-9",
    });
    await handlers.invalidateUserAccessSnapshot?.({ userId: "user-1" });

    expect(mockedInvalidateLocalByAgent).toHaveBeenCalledWith(consumersNsp, "agent-9");
    expect(mockedInvalidateLocalClientAgent).toHaveBeenCalledWith(
      consumersNsp,
      "client-1",
      "agent-9",
    );
    expect(mockedInvalidateLocalUser).toHaveBeenCalledWith(consumersNsp, "user-1");
    expect(consumersNsp.in).not.toHaveBeenCalled();
  });
});
