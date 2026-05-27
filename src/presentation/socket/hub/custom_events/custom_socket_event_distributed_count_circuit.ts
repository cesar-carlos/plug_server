import { env } from "../../../../shared/config/env";
import { AppError } from "../../../../shared/errors/app_error";
import {
  noteCustomSocketEventPublishDistributedRecipientCountCircuitClosed,
  noteCustomSocketEventPublishDistributedRecipientCountCircuitOpened,
  noteCustomSocketEventPublishDistributedRecipientCountCircuitRejected,
  noteCustomSocketEventPublishDistributedRecipientCountFailed,
  noteCustomSocketEventPublishDistributedRecipientCountSkipped,
} from "../../../../shared/metrics/socket_consumer.metrics";
import { logger } from "../../../../shared/utils/logger";
import { isSocketIoRedisAdapterActive } from "../../../../infrastructure/redis/socket_io_redis_adapter";
import {
  resolveCustomSocketEventRoomRecipientCountStrategy,
  toRoomRecipientCountFromStrategy,
  type RemoteSocketLike,
  type ResolvedCustomSocketEventRoomRecipientCount,
} from "./custom_socket_event_room_recipient_count";

export type DistributedCountCircuitState = {
  consecutiveFailures: number;
  openedUntilEpochMs: number;
};

export const createInitialDistributedCountCircuitState = (): DistributedCountCircuitState => ({
  consecutiveFailures: 0,
  openedUntilEpochMs: 0,
});

export const isCustomEventDistributedCountCircuitOpen = (
  circuit: DistributedCountCircuitState,
  nowEpochMs = Date.now(),
): boolean => circuit.openedUntilEpochMs > nowEpochMs;

export const resetCustomEventDistributedCountCircuit = (
  circuit: DistributedCountCircuitState,
  hasOtherOpenCircuit: () => boolean,
  nowEpochMs = Date.now(),
): void => {
  const wasOpen = isCustomEventDistributedCountCircuitOpen(circuit, nowEpochMs);
  circuit.consecutiveFailures = 0;
  circuit.openedUntilEpochMs = 0;
  if (wasOpen && !hasOtherOpenCircuit()) {
    noteCustomSocketEventPublishDistributedRecipientCountCircuitClosed();
  }
};

export const recordCustomEventDistributedCountFailure = (
  circuit: DistributedCountCircuitState,
  nowEpochMs = Date.now(),
): void => {
  circuit.consecutiveFailures += 1;
  if (
    !isCustomEventDistributedCountCircuitOpen(circuit, nowEpochMs) &&
    circuit.consecutiveFailures >= env.restSocketEventDistributedCountFailureThreshold
  ) {
    circuit.openedUntilEpochMs = nowEpochMs + env.restSocketEventDistributedCountFailureOpenMs;
    noteCustomSocketEventPublishDistributedRecipientCountCircuitOpened();
  }
};

export const enforceCustomEventDistributedCountCircuit = (
  circuit: DistributedCountCircuitState,
  eventName: string,
  nowEpochMs = Date.now(),
): void => {
  if (
    circuit.openedUntilEpochMs > 0 &&
    !isCustomEventDistributedCountCircuitOpen(circuit, nowEpochMs)
  ) {
    circuit.consecutiveFailures = 0;
    circuit.openedUntilEpochMs = 0;
  }
  if (!isCustomEventDistributedCountCircuitOpen(circuit, nowEpochMs)) {
    return;
  }
  noteCustomSocketEventPublishDistributedRecipientCountCircuitRejected();
  logger.warn("socket_custom_event_publish_distributed_count_circuit_open", {
    eventName,
    circuitOpenUntilEpochMs: circuit.openedUntilEpochMs,
  });
  throw new AppError("socket event distributed recipient count temporarily unavailable", {
    statusCode: 503,
    code: "SERVICE_UNAVAILABLE",
    details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
  });
};

/**
 * Counts subscribers for a custom event room.
 *
 * The caller chooses **how** the distributed count is obtained by passing
 * one of the two fetch hooks below — they are mutually exclusive:
 *
 *   - `fetchDistributedCount`: legacy "count only" path. Cheap when the
 *     caller does not also need the underlying sockets (e.g. agent room
 *     audits where only the cardinality matters).
 *   - `fetchDistributedSockets`: returns the underlying `RemoteSocket[]`
 *     so downstream code can reuse the array (length = count) without a
 *     second `fetchSockets()` cluster RPC. Used by the publish path,
 *     which also needs `recipientPrincipalIds`.
 */
export const countDistributedRoomRecipients = async <
  S extends RemoteSocketLike = RemoteSocketLike,
>(input: {
  readonly circuit: DistributedCountCircuitState;
  readonly localRecipients: number;
  readonly room: string;
  readonly fetchDistributedCount?: () => Promise<number>;
  readonly fetchDistributedSockets?: () => Promise<ReadonlyArray<S>>;
  readonly onCircuitReset: () => void;
}): Promise<ResolvedCustomSocketEventRoomRecipientCount<S>> => {
  const redisAdapterActive = isSocketIoRedisAdapterActive();
  const strategy = resolveCustomSocketEventRoomRecipientCountStrategy({
    redisAdapterActive,
    localRecipients: input.localRecipients,
    maxRecipients: env.restSocketEventMaxRecipients,
  });

  if (strategy.kind !== "fetch_distributed") {
    input.onCircuitReset();
    if (redisAdapterActive) {
      noteCustomSocketEventPublishDistributedRecipientCountSkipped();
    }
    /**
     * The non-distributed strategies never populate `fetchedSockets`, so the
     * cast widens the un-generic helper result to the caller's `S` parameter
     * without changing runtime behavior.
     */
    return toRoomRecipientCountFromStrategy(
      strategy,
    ) as ResolvedCustomSocketEventRoomRecipientCount<S>;
  }

  try {
    if (input.fetchDistributedSockets !== undefined) {
      const sockets = await input.fetchDistributedSockets();
      input.onCircuitReset();
      return {
        recipients: sockets.length,
        recipientCountBestEffort: false,
        recipientCountLocalOnly: false,
        fetchedSockets: sockets,
      };
    }
    if (input.fetchDistributedCount === undefined) {
      throw new Error("countDistributedRoomRecipients: missing fetch hook");
    }
    const recipients = await input.fetchDistributedCount();
    input.onCircuitReset();
    return {
      recipients,
      recipientCountBestEffort: false,
      recipientCountLocalOnly: false,
    };
  } catch (error: unknown) {
    noteCustomSocketEventPublishDistributedRecipientCountFailed();
    recordCustomEventDistributedCountFailure(input.circuit);
    logger.warn("socket_room_distributed_count_failed_fallback_local", {
      room: input.room,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      recipients: input.localRecipients,
      recipientCountBestEffort: true,
      recipientCountLocalOnly: false,
    };
  }
};
