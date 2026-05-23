import { agentsNamespace } from "../../../socket";
import { env } from "../../../shared/config/env";
import { noteAgentIdleTimeoutDisconnect } from "../../../shared/metrics/socket_agent.metrics";
import { logger } from "../../../shared/utils/logger";

import { agentRegistry } from "./agent_registry";

let sweepTimer: NodeJS.Timeout | null = null;

export const sweepIdleAgentConnections = (): number => {
  if (env.socketAgentIdleTimeoutMs <= 0) {
    return 0;
  }

  const idleAgents = agentRegistry.listIdle(env.socketAgentIdleTimeoutMs);
  let disconnected = 0;

  for (const agent of idleAgents) {
    const socket = agentsNamespace?.sockets.get(agent.socketId);
    if (!socket?.connected) {
      continue;
    }

    logger.info("agent_idle_timeout_disconnect", {
      agentId: agent.agentId,
      socketId: agent.socketId,
      idleTimeoutMs: env.socketAgentIdleTimeoutMs,
    });
    socket.disconnect(true);
    disconnected += 1;
  }

  if (disconnected > 0) {
    noteAgentIdleTimeoutDisconnect(disconnected);
  }

  return disconnected;
};

export const startAgentIdleTimeoutScheduler = (): void => {
  if (sweepTimer !== null) {
    return;
  }

  if (env.socketAgentIdleTimeoutMs <= 0 || env.socketAgentIdleSweepIntervalMs <= 0) {
    return;
  }

  sweepTimer = setInterval(() => {
    sweepIdleAgentConnections();
  }, env.socketAgentIdleSweepIntervalMs);
  sweepTimer.unref?.();
};

export const stopAgentIdleTimeoutScheduler = (): void => {
  if (sweepTimer === null) {
    return;
  }

  clearInterval(sweepTimer);
  sweepTimer = null;
};
