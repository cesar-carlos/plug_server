import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { RemoteSocket, Server, Socket } from "socket.io";

import {
  createInitialDistributedCountCircuitState,
  type DistributedCountCircuitState,
} from "./presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit";
import type { PendingAgentProfilePush } from "./presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";
import { env } from "./shared/config/env";
import type { JwtAccessPayload } from "./shared/utils/jwt";
import { TtlCache } from "./shared/utils/ttl_cache";

export type ConsumerSocketData = {
  user?: JwtAccessPayload;
};

export type HubSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  ConsumerSocketData
>;

export type PendingAgentProfilePushEntry = PendingAgentProfilePush;

/**
 * Cluster-wide remote socket as returned by `namespace.in(room).fetchSockets()`.
 * We only ever read `data.user.sub`, but typing it here keeps the publish path
 * decoupled from the internal `RemoteSocket` shape.
 */
export type RoomRemoteSocket = RemoteSocket<DefaultEventsMap, ConsumerSocketData>;

export type RoomRecipientCount = {
  readonly recipients: number;
  readonly recipientCountBestEffort: boolean;
  readonly recipientCountLocalOnly: boolean;
  /**
   * Populated only when `countSocketsInRoom` was called with `captureSockets:
   * true` AND the strategy actually issued the cluster-wide RPC. Callers that
   * also need per-socket data (principal ids, etc.) should reuse this array
   * instead of issuing a second `fetchSockets()` call. Length === `recipients`.
   */
  readonly fetchedSockets?: ReadonlyArray<RoomRemoteSocket>;
};

export type SocketSinkDisposer = () => void;

export type SocketServerState = {
  readonly io: Server;
  readonly agentsNamespace: ReturnType<Server["of"]>;
  readonly consumersNamespace: ReturnType<Server["of"]>;
  readonly sinkDisposers: SocketSinkDisposer[];
  readonly clientProfileRecipientsCacheByAgentId: TtlCache<string, readonly string[]>;
  readonly pendingAgentProfilePushByAgentId: Map<string, PendingAgentProfilePushEntry>;
  readonly pendingApprovedAgentIdsByClientId: Map<string, Promise<readonly string[]>>;
  readonly profilePushRecipientsInFlightByAgentId: Map<string, Promise<readonly string[]>>;
  readonly customEventDistributedCountCircuit: DistributedCountCircuitState;
  conversationSweepTimer: NodeJS.Timeout | null;
  consumerClientAgentRoomReconcileTimer: NodeJS.Timeout | null;
  consumerClientAgentRoomReconcileStartTimeout: NodeJS.Timeout | null;
  consumerClientAgentRoomReconcileInFlight: Promise<void> | null;
  consumerClientAgentRoomReconcileCursor: number;
  shuttingDown: boolean;
  profilePushFlushInFlight: Set<Promise<void>>;
};

export type HubNamespace = ReturnType<Server["of"]>;

export const socketServerStates = new Map<Server, SocketServerState>();
export const activeSocketServers: Server[] = [];

export const createSocketServerState = (
  io: Server,
  agentsNsp: ReturnType<Server["of"]>,
  consumersNsp: ReturnType<Server["of"]>,
): SocketServerState => ({
  io,
  agentsNamespace: agentsNsp,
  consumersNamespace: consumersNsp,
  sinkDisposers: [],
  clientProfileRecipientsCacheByAgentId: new TtlCache<string, readonly string[]>(
    env.socketClientAgentProfileRecipientCacheTtlMs,
    env.socketClientAgentProfileRecipientCacheMaxSize,
  ),
  pendingAgentProfilePushByAgentId: new Map<string, PendingAgentProfilePush>(),
  pendingApprovedAgentIdsByClientId: new Map<string, Promise<readonly string[]>>(),
  profilePushRecipientsInFlightByAgentId: new Map<string, Promise<readonly string[]>>(),
  customEventDistributedCountCircuit: createInitialDistributedCountCircuitState(),
  conversationSweepTimer: null,
  consumerClientAgentRoomReconcileTimer: null,
  consumerClientAgentRoomReconcileStartTimeout: null,
  consumerClientAgentRoomReconcileInFlight: null,
  consumerClientAgentRoomReconcileCursor: 0,
  shuttingDown: false,
  profilePushFlushInFlight: new Set<Promise<void>>(),
});

export const hasOtherOpenCustomEventDistributedCountCircuit = (
  currentState: SocketServerState,
  nowEpochMs = Date.now(),
): boolean => {
  for (const state of socketServerStates.values()) {
    if (state === currentState) {
      continue;
    }
    if (state.customEventDistributedCountCircuit.openedUntilEpochMs > nowEpochMs) {
      return true;
    }
  }
  return false;
};

export let agentsNamespace: ReturnType<Server["of"]> | null = null;
export let consumersNamespace: ReturnType<Server["of"]> | null = null;

export const getAgentsNamespace = (): ReturnType<Server["of"]> | null => agentsNamespace;
export const getConsumersNamespace = (): ReturnType<Server["of"]> | null => consumersNamespace;

export const resolveCurrentSocketServer = (): Server | null =>
  activeSocketServers.length > 0 ? activeSocketServers[activeSocketServers.length - 1]! : null;

export const registerActiveSocketServer = (io: Server): void => {
  activeSocketServers.push(io);
  const state = socketServerStates.get(io);
  agentsNamespace = state?.agentsNamespace ?? null;
  consumersNamespace = state?.consumersNamespace ?? null;
};

export const unregisterActiveSocketServer = (io: Server): void => {
  const index = activeSocketServers.lastIndexOf(io);
  if (index >= 0) {
    activeSocketServers.splice(index, 1);
  }
  const current = resolveCurrentSocketServer();
  const state = current ? socketServerStates.get(current) : undefined;
  agentsNamespace = state?.agentsNamespace ?? null;
  consumersNamespace = state?.consumersNamespace ?? null;
};
