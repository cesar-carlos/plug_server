import { createServer } from "node:http";

import { createApp } from "./app";
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
import { prismaClient } from "./infrastructure/database/prisma/client";
import { closeSocketServer, createSocketServer } from "./socket";
import { container } from "./shared/di/container";
import { env } from "./shared/config/env";
import { logger } from "./shared/utils/logger";

const app = createApp();
const httpServer = createServer(app);
const io = createSocketServer(httpServer);

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

httpServer.listen(env.port, "0.0.0.0", () => {
  logger.info("HTTP server started", {
    appName: env.appName,
    port: env.port,
    environment: env.nodeEnv,
  });
});

let shutdownInProgress = false;

const closeHttpServer = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
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

    await closeSocketServer(io, signal);
    await closeHttpServer();
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
