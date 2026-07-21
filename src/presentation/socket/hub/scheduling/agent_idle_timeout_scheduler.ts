import type { Namespace } from "socket.io";

import { env } from "../../../../shared/config/env";
import { noteAgentIdleTimeoutDisconnect } from "../../../../shared/metrics/socket_agent.metrics";
import { logger } from "../../../../shared/utils/logger";

import { agentRegistry } from "../registries/agent_registry";

let sweepTimer: NodeJS.Timeout | null = null;
let _agentsNamespace: Namespace | null = null;
let sweepInFlight = false;

export const sweepIdleAgentConnections = (): number => {
  if (env.socketAgentIdleTimeoutMs <= 0) {
    return 0;
  }

  const idleAgents = agentRegistry.listIdleRefs(env.socketAgentIdleTimeoutMs);
  let disconnected = 0;

  for (const agent of idleAgents) {
    const socket = _agentsNamespace?.sockets.get(agent.socketId);
    if (!socket?.connected) {
      agentRegistry.removeBySocketId(agent.socketId);
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

export const startAgentIdleTimeoutScheduler = (namespace: Namespace): void => {
  _agentsNamespace = namespace;

  if (sweepTimer !== null) {
    return;
  }

  if (env.socketAgentIdleTimeoutMs <= 0 || env.socketAgentIdleSweepIntervalMs <= 0) {
    return;
  }

  sweepTimer = setInterval(() => {
    if (sweepInFlight) {
      return;
    }
    sweepInFlight = true;
    try {
      sweepIdleAgentConnections();
    } finally {
      sweepInFlight = false;
    }
  }, env.socketAgentIdleSweepIntervalMs);
  sweepTimer.unref?.();
};

export const stopAgentIdleTimeoutScheduler = (): void => {
  if (sweepTimer === null) {
    return;
  }

  clearInterval(sweepTimer);
  sweepTimer = null;
  _agentsNamespace = null;
};
