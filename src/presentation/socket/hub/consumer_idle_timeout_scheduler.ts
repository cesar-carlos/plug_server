import type { Namespace } from "socket.io";

import { env } from "../../../shared/config/env";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import { noteConsumerIdleTimeoutDisconnect } from "../../../shared/metrics/socket_consumer.metrics";
import { logger } from "../../../shared/utils/logger";

import { consumerRegistry } from "./consumer_registry";

let sweepTimer: NodeJS.Timeout | null = null;
let _consumersNamespace: Namespace | null = null;

export const sweepIdleConsumerConnections = (): number => {
  if (env.socketConsumerIdleTimeoutMs <= 0) {
    return 0;
  }

  const idleConsumers = consumerRegistry.listIdle(env.socketConsumerIdleTimeoutMs);
  let disconnected = 0;

  for (const consumer of idleConsumers) {
    const socket = _consumersNamespace?.sockets.get(consumer.socketId);
    if (!socket?.connected) {
      continue;
    }

    logger.info("consumer_idle_timeout_disconnect", {
      socketId: consumer.socketId,
      userId: consumer.userId,
      principalType: consumer.principalType,
      idleTimeoutMs: env.socketConsumerIdleTimeoutMs,
    });
    socket.emit(
      socketEvents.appError,
      buildLegacySocketAppErrorPayload(
        "CONSUMER_IDLE_TIMEOUT",
        "Consumer socket idle timeout exceeded",
      ),
    );
    socket.disconnect(true);
    disconnected += 1;
  }

  if (disconnected > 0) {
    noteConsumerIdleTimeoutDisconnect(disconnected);
  }

  return disconnected;
};

export const startConsumerIdleTimeoutScheduler = (namespace: Namespace): void => {
  _consumersNamespace = namespace;

  if (sweepTimer !== null) {
    return;
  }

  if (env.socketConsumerIdleTimeoutMs <= 0 || env.socketConsumerIdleSweepIntervalMs <= 0) {
    return;
  }

  sweepTimer = setInterval(() => {
    sweepIdleConsumerConnections();
  }, env.socketConsumerIdleSweepIntervalMs);
  sweepTimer.unref?.();
};

export const stopConsumerIdleTimeoutScheduler = (): void => {
  if (sweepTimer === null) {
    return;
  }

  clearInterval(sweepTimer);
  sweepTimer = null;
  _consumersNamespace = null;
};
