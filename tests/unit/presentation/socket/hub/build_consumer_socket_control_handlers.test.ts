import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Namespace } from "socket.io";

vi.mock(
  "../../../../../src/presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile",
  () => ({
    invalidateApprovedAgentIdsCache: vi.fn(),
  }),
);

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  clearConsumerSocketAgentAccessSnapshot: vi.fn(),
  clearAllConsumerSocketAgentAccessSnapshots: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/consumer_identity_rooms", () => ({
  buildConsumerAgentProfileRoom: vi.fn((agentId: string) => `consumer:agent-profile:${agentId}`),
  buildConsumerClientAgentRoom: vi.fn(
    ({ clientId, agentId }: { clientId: string; agentId: string }) =>
      `consumer:client-agent:${clientId}:${agentId}`,
  ),
  buildConsumerClientRoom: vi.fn((clientId: string) => `client:${clientId}`),
  joinConsumerClientAgentRoom: vi.fn(async () => undefined),
}));

import { buildConsumerSocketControlHandlers } from "../../../../../src/presentation/socket/hub/build_consumer_socket_control_handlers";
import { invalidateApprovedAgentIdsCache } from "../../../../../src/presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";
import { clearConsumerSocketAgentAccessSnapshot } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { buildConsumerAgentProfileRoom } from "../../../../../src/presentation/socket/hub/consumer_identity_rooms";

const mockedInvalidateApprovedCache = vi.mocked(invalidateApprovedAgentIdsCache);
const mockedClearSnapshot = vi.mocked(clearConsumerSocketAgentAccessSnapshot);
const mockedBuildAgentProfileRoom = vi.mocked(buildConsumerAgentProfileRoom);

describe("buildConsumerSocketControlHandlers", () => {
  const disconnectConsumerSocketsInRoom = vi.fn(async () => 0);
  const clientProfileRecipientsCacheByAgentId = { delete: vi.fn() };
  const consumersNsp = {
    in: vi.fn(),
    sockets: { get: vi.fn() },
  } as unknown as Namespace;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedBuildAgentProfileRoom.mockImplementation(
      (agentId: string) => `consumer:agent-profile:${agentId}`,
    );
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

  it("invalidates agent access snapshots across replicas via fetchSockets", async () => {
    const remoteA = { id: "sock-a" };
    const remoteB = { id: "sock-b" };
    const fetchSockets = vi.fn(async () => [remoteA, remoteB]);
    (consumersNsp.in as ReturnType<typeof vi.fn>).mockReturnValue({ fetchSockets });

    const handlers = buildConsumerSocketControlHandlers({
      consumersNsp,
      clientProfileRecipientsCacheByAgentId,
      disconnectConsumerSocketsInRoom,
    });

    await handlers.invalidateAgentAccessSnapshot?.({ agentId: "agent-9" });

    expect(consumersNsp.in).toHaveBeenCalledWith("consumer:agent-profile:agent-9");
    expect(mockedClearSnapshot).toHaveBeenCalledWith(remoteA, "agent-9");
    expect(mockedClearSnapshot).toHaveBeenCalledWith(remoteB, "agent-9");
  });
});
