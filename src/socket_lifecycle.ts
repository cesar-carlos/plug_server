import type { Server } from "socket.io";

import { agentRegistry } from "./presentation/socket/hub/registries/agent_registry";
import { conversationRegistry } from "./presentation/socket/hub/registries/conversation_registry";
import { consumerRegistry } from "./presentation/socket/hub/registries/consumer_registry";
import {
  resetSocketBridgeState,
  unregisterConsumerBridgeServer,
  unregisterSocketBridgeServer,
} from "./presentation/socket/hub/relay/rpc_bridge";
import {
  resetRelayRateLimiterState,
} from "./presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import {
  resetAgentsCommandSocketRateLimitState,
} from "./presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter";
import {
  resetClientSocketEventPublishSocketRateLimitState,
} from "./presentation/socket/hub/rate_limits/client_socket_event_publish_socket_rate_limiter";
import {
  resetAgentProfileSocketRateLimitState,
} from "./presentation/socket/hub/rate_limits/agent_profile_socket_rate_limiter";
import { resetConsumerCommandAbortRegistry } from "./presentation/socket/consumers/consumer_command_abort_registry";
import {
  resetCustomSocketEventSubscriptions,
} from "./presentation/socket/hub/custom_events/custom_socket_event_subscription_registry";
import {
  resetCustomSocketEventSubscriptionRateLimitState,
} from "./presentation/socket/hub/rate_limits/custom_socket_event_subscription_limiter";
import {
  resetAgentRegisterRateLimitState,
} from "./presentation/socket/hub/rate_limits/agent_register_rate_limit";
import {
  resetAgentProfileSyncScheduler,
} from "./presentation/socket/hub/register_agent_socket_handlers";
import {
  clearConsumerProfilePushState,
} from "./presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";
import { resetRestBridgeMetrics } from "./application/services/rest_bridge_metrics.service";
import { resetBridgeRpcMethodMetrics } from "./application/services/bridge_rpc_method_metrics.service";
import { resetSocketConsumerMetrics } from "./shared/metrics/socket_consumer.metrics";
import { resetSocketAgentMetrics } from "./shared/metrics/socket_agent.metrics";
import { resetSocketHubErrorMetrics } from "./shared/metrics/socket_hub_error.metrics";
import {
  buildLegacySocketAppErrorPayload,
} from "./shared/constants/socket_app_error";
import { socketEvents, SOCKET_NAMESPACES } from "./shared/constants/socket_events";
import { logger } from "./shared/utils/logger";
import {
  activeSocketServers,
  hasOtherOpenCustomEventDistributedCountCircuit,
  socketServerStates,
  unregisterActiveSocketServer,
  type SocketServerState,
} from "./socket_state";

const emitServerShutdownNotice = (io: Server, signal: string): void => {
  const payload = buildLegacySocketAppErrorPayload(
    "SERVER_SHUTDOWN",
    `Server is shutting down (${signal}). Reconnect after a few seconds.`,
  );

  io.of(SOCKET_NAMESPACES.agents).emit(socketEvents.appError, payload);
  io.of(SOCKET_NAMESPACES.consumers).emit(socketEvents.appError, payload);
};

export const clearSocketServerSinkDisposers = (io: Server): void => {
  const state = socketServerStates.get(io);
  if (!state) {
    return;
  }
  for (const dispose of state.sinkDisposers) {
    dispose();
  }
  state.sinkDisposers.length = 0;
};

const awaitInFlightPromises = async (
  promises: readonly Promise<unknown>[],
  logEvent: string,
): Promise<void> => {
  if (promises.length === 0) {
    return;
  }
  await Promise.all(
    promises.map((promise) =>
      promise.catch((error: unknown) => {
        logger.warn(logEvent, {
          message: error instanceof Error ? error.message : String(error),
        });
      }),
    ),
  );
};

const stopSocketServerLifecycleTasks = async (state: SocketServerState): Promise<void> => {
  state.shuttingDown = true;

  if (state.conversationSweepTimer) {
    clearInterval(state.conversationSweepTimer);
    state.conversationSweepTimer = null;
  }
  if (state.consumerClientAgentRoomReconcileTimer) {
    clearInterval(state.consumerClientAgentRoomReconcileTimer);
    state.consumerClientAgentRoomReconcileTimer = null;
  }
  if (state.consumerClientAgentRoomReconcileStartTimeout) {
    clearTimeout(state.consumerClientAgentRoomReconcileStartTimeout);
    state.consumerClientAgentRoomReconcileStartTimeout = null;
  }

  const reconcileInFlight = state.consumerClientAgentRoomReconcileInFlight;
  if (reconcileInFlight !== null) {
    await reconcileInFlight.catch((error: unknown) => {
      logger.warn("consumer_socket_client_agent_room_reconcile_shutdown_drain_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  state.consumerClientAgentRoomReconcileInFlight = null;
  state.consumerClientAgentRoomReconcileCursor = 0;

  await awaitInFlightPromises(
    [...state.profilePushFlushInFlight],
    "client_agent_profile_push_shutdown_drain_failed",
  );
  state.profilePushFlushInFlight.clear();
  await awaitInFlightPromises(
    [...state.profilePushRecipientsInFlightByAgentId.values()],
    "client_agent_profile_push_recipient_shutdown_drain_failed",
  );
  await awaitInFlightPromises(
    [...state.pendingApprovedAgentIdsByClientId.values()],
    "consumer_socket_client_agent_room_bootstrap_shutdown_drain_failed",
  );

  clearConsumerProfilePushState(state, () => hasOtherOpenCustomEventDistributedCountCircuit(state));
};

export const stopSocketServerLifecycleTasksForTests = stopSocketServerLifecycleTasks;

export const closeSocketServer = async (io: Server, signal = "shutdown"): Promise<void> => {
  emitServerShutdownNotice(io, signal);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const state = socketServerStates.get(io);
  if (state) {
    await stopSocketServerLifecycleTasks(state);
  }

  clearSocketServerSinkDisposers(io);
  unregisterSocketBridgeServer(io.of(SOCKET_NAMESPACES.agents));
  unregisterConsumerBridgeServer(io.of(SOCKET_NAMESPACES.consumers));
  unregisterActiveSocketServer(io);
  socketServerStates.delete(io);

  if (activeSocketServers.length === 0) {
    resetRelayRateLimiterState();
    resetAgentsCommandSocketRateLimitState();
    resetClientSocketEventPublishSocketRateLimitState();
    resetAgentProfileSocketRateLimitState();
    resetConsumerCommandAbortRegistry();
    resetCustomSocketEventSubscriptions();
    resetCustomSocketEventSubscriptionRateLimitState();
    resetSocketConsumerMetrics();
    resetSocketAgentMetrics();
    resetAgentRegisterRateLimitState();
    resetAgentProfileSyncScheduler();
    resetSocketBridgeState();
    resetRestBridgeMetrics();
    resetBridgeRpcMethodMetrics();
    resetSocketHubErrorMetrics();
    conversationRegistry.clear();
    agentRegistry.clear();
    consumerRegistry.clear();
  }

  await new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
};
