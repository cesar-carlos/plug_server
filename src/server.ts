import { createServer, type Server as HttpServer } from "node:http";

import type { Server as SocketIoServer } from "socket.io";

import {
  startAgentProfileMaintenanceScheduler,
  startClientAgentAccessExpiryScheduler,
  stopAgentProfileMaintenanceScheduler,
  stopClientAgentAccessExpiryScheduler,
  waitForAgentDataMaintenanceDrain,
} from "./application/services/agent_data_maintenance.service";
import {
  flushPendingBridgeLatencyTraces,
  startBridgeLatencyTraceRetentionScheduler,
  stopBridgeLatencyTraceRetentionScheduler,
  waitForBridgeLatencyTraceDrain,
} from "./application/services/bridge_latency_trace.service";
import {
  startBridgeLatencyTraceRollupScheduler,
  stopBridgeLatencyTraceRollupScheduler,
} from "./application/services/bridge_latency_trace_rollup.service";
import {
  flushRegistrationEmailOutbox,
  startRegistrationEmailOutboxDeadLetterScheduler,
  startRegistrationEmailOutboxWorker,
  stopRegistrationEmailOutboxDeadLetterScheduler,
  stopRegistrationEmailOutboxWorker,
  waitForRegistrationEmailOutboxDrain,
} from "./application/services/registration_email_outbox.service";
import {
  flushPendingSocketAuditEvents,
  waitForSocketAuditDrain,
  startSocketAuditRetentionScheduler,
  stopSocketAuditRetentionScheduler,
} from "./application/services/socket_audit.service";
import {
  closeRestHttpRateLimitRedis,
  initRestHttpRateLimitRedis,
} from "./infrastructure/redis/rest_rate_limit_redis";
import {
  closeSocketRateLimitRedis,
  initSocketRateLimitRedis,
} from "./infrastructure/redis/socket_rate_limit_redis";
import {
  closeSocketIoRedisAdapter,
  initSocketIoRedisAdapter,
} from "./infrastructure/redis/socket_io_redis_adapter";
import {
  closeClientSocketEventPublishIdempotencyRedis,
  initClientSocketEventPublishIdempotencyRedis,
} from "./infrastructure/redis/client_socket_event_publish_idempotency_redis";
import { prismaClient } from "./infrastructure/database/prisma/client";
import {
  startAgentIdleTimeoutScheduler,
  stopAgentIdleTimeoutScheduler,
} from "./presentation/socket/hub/scheduling/agent_idle_timeout_scheduler";
import {
  startConsumerIdleTimeoutScheduler,
  stopConsumerIdleTimeoutScheduler,
} from "./presentation/socket/hub/scheduling/consumer_idle_timeout_scheduler";
import { closeSocketServer, createSocketServer } from "./socket";
import { SOCKET_NAMESPACES } from "./shared/constants/socket_events";
import { container } from "./shared/di/container";
import { env } from "./shared/config/env";
import { logEnvRestSocketEventHints } from "./shared/config/log_env_rest_socket_event_hints";
import { logEnvWorldAlignmentHints } from "./shared/config/log_env_world_alignment";
import { logSocketAuthBootstrapHints } from "./shared/config/log_socket_auth_bootstrap_hints";
import { logSocketConsumerBootstrapHints } from "./shared/config/log_socket_consumer_bootstrap_hints";
import { warnIfConnectionReadyLegacyCompatExpired } from "./presentation/socket/hub/handshake/connection_ready_handshake";
import { warnIfAgentsCommandLegacyCompatExpired } from "./presentation/socket/consumers/agents_command_wire";
import { warnIfAgentsStreamPullLegacyCompatExpired } from "./presentation/socket/consumers/agents_stream_pull_wire";
import { logger } from "./shared/utils/logger";

let httpServer: HttpServer | undefined;
let io: SocketIoServer | undefined;

let shutdownInProgress = false;

const bootstrap = async (): Promise<void> => {
  await initRestHttpRateLimitRedis();
  await initSocketRateLimitRedis();
  await initClientSocketEventPublishIdempotencyRedis();

  const { registerHttpRateLimits } =
    await import("./presentation/http/middlewares/rate_limit.middleware");
  registerHttpRateLimits();

  const { createApp } = await import("./app");
  const app = createApp();
  httpServer = createServer(app);
  // Protects against slow-loris and hung client connections. Value 0 disables.
  if (env.httpRequestTimeoutMs > 0) {
    httpServer.requestTimeout = env.httpRequestTimeoutMs;
  }
  io = createSocketServer(httpServer);
  await initSocketIoRedisAdapter(io);
  logSocketAuthBootstrapHints();
  logSocketConsumerBootstrapHints();
  warnIfConnectionReadyLegacyCompatExpired();
  warnIfAgentsCommandLegacyCompatExpired();
  warnIfAgentsStreamPullLegacyCompatExpired();
  logEnvWorldAlignmentHints();
  logEnvRestSocketEventHints();

  startSocketAuditRetentionScheduler({
    retentionDays: env.socketAuditRetentionDays,
    intervalMs: env.socketAuditRetentionIntervalMinutes * 60 * 1000,
    batchSize: env.socketAuditPruneBatchSize,
  });

  startBridgeLatencyTraceRetentionScheduler({
    intervalMs: env.bridgeLatencyTraceRetentionIntervalMinutes * 60 * 1000,
    batchSize: env.bridgeLatencyTracePruneBatchSize,
  });
  startBridgeLatencyTraceRollupScheduler();
  startAgentProfileMaintenanceScheduler({
    intervalMs: env.agentProfileMaintenanceIntervalMinutes * 60 * 1000,
    batchSize: env.agentProfileMaintenancePruneBatchSize,
  });
  startClientAgentAccessExpiryScheduler({
    intervalMs: env.clientAgentAccessExpirySweepIntervalMinutes * 60 * 1000,
    batchSize: env.clientAgentAccessExpirySweepBatchSize,
  });
  startRegistrationEmailOutboxWorker(container.emailSender);
  startRegistrationEmailOutboxDeadLetterScheduler();
  startAgentIdleTimeoutScheduler(io.of(SOCKET_NAMESPACES.agents));
  startConsumerIdleTimeoutScheduler(io.of(SOCKET_NAMESPACES.consumers));

  httpServer.listen(env.port, "0.0.0.0", () => {
    logger.info("HTTP server started", {
      appName: env.appName,
      port: env.port,
      environment: env.nodeEnv,
    });
  });
};

void bootstrap().catch((error: unknown) => {
  logger.error("bootstrap_failed", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});

const closeHttpServer = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (httpServer === undefined) {
      resolve();
      return;
    }
    httpServer.close((error) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ERR_SERVER_NOT_RUNNING" || error.message?.includes("not running")) {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      resolve();
    });
  });

const shutdown = async (signal: string): Promise<void> => {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  logger.info("Shutdown signal received", { signal });

  try {
    stopSocketAuditRetentionScheduler();
    stopBridgeLatencyTraceRetentionScheduler();
    stopBridgeLatencyTraceRollupScheduler();
    stopAgentProfileMaintenanceScheduler();
    stopClientAgentAccessExpiryScheduler();
    stopRegistrationEmailOutboxWorker();
    stopRegistrationEmailOutboxDeadLetterScheduler();
    stopAgentIdleTimeoutScheduler();
    stopConsumerIdleTimeoutScheduler();
    await flushPendingSocketAuditEvents();
    const auditDrain = await waitForSocketAuditDrain(2_500);
    if (!auditDrain.drained) {
      logger.warn("socket_audit_drain_timeout", { pending: auditDrain.pending });
    }

    await flushPendingBridgeLatencyTraces();
    const traceDrain = await waitForBridgeLatencyTraceDrain(2_500);
    if (!traceDrain.drained) {
      logger.warn("bridge_latency_trace_drain_timeout", { pending: traceDrain.pending });
    }

    const maintenanceDrain = await waitForAgentDataMaintenanceDrain(2_500);
    if (!maintenanceDrain.drained) {
      logger.warn("agent_data_maintenance_drain_timeout", { pending: maintenanceDrain.pending });
    }

    await flushRegistrationEmailOutbox(container.emailSender);
    const outboxDrain = await waitForRegistrationEmailOutboxDrain(2_500);
    if (!outboxDrain.drained) {
      logger.warn("registration_email_outbox_drain_timeout", { pending: outboxDrain.pending });
    }

    if (io !== undefined) {
      await closeSocketServer(io, signal);
    }
    await closeHttpServer();
    await closeSocketIoRedisAdapter();
    await closeClientSocketEventPublishIdempotencyRedis();
    await closeRestHttpRateLimitRedis();
    await closeSocketRateLimitRedis();
    await prismaClient.$disconnect();
    logger.info("Shutdown completed", { signal });
    process.exit(0);
  } catch (error: unknown) {
    logger.error("Shutdown failed", {
      signal,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("unhandled_promise_rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (error: Error) => {
  logger.error("uncaught_exception", {
    message: error.message,
    stack: error.stack,
    name: error.name,
  });
  void shutdown("uncaughtException");
});
