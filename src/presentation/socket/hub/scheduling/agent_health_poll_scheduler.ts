import { randomUUID } from "node:crypto";

import { env } from "../../../../shared/config/env";
import { isHealthPiggybackNegotiated } from "../../../../shared/constants/transport_extension_negotiation";
import { logger } from "../../../../shared/utils/logger";
import type {
  DispatchRpcCommandInput,
  DispatchRpcCommandResult,
} from "../relay/rpc_bridge_dispatch_command";

import { agentRegistry } from "../registries/agent_registry";

export type AgentHealthPollDispatch = (
  input: DispatchRpcCommandInput,
) => Promise<DispatchRpcCommandResult>;

let pollTimer: NodeJS.Timeout | null = null;
let dispatchCommand: AgentHealthPollDispatch | null = null;
let pollInFlight = false;

const healthPollTimeoutMs = 10_000;

export const runAgentHealthPollSweep = async (
  dispatch: AgentHealthPollDispatch,
  nowMs = Date.now(),
): Promise<{ polled: number; skipped: number; failed: number }> => {
  const agents = agentRegistry.listAll();
  let polled = 0;
  let skipped = 0;
  let failed = 0;

  for (const agent of agents) {
    const readiness = agentRegistry.getProtocolReadiness(agent.agentId);
    if (!readiness.ready) {
      continue;
    }

    if (isHealthPiggybackNegotiated(agent.capabilities)) {
      if (agentRegistry.shouldSkipScheduledHealthPoll(agent.agentId, nowMs)) {
        skipped += 1;
        continue;
      }
    }

    try {
      await dispatch({
        agentId: agent.agentId,
        timeoutMs: healthPollTimeoutMs,
        command: {
          jsonrpc: "2.0",
          method: "agent.getHealth",
          id: `hub-health-poll-${randomUUID()}`,
          params: {},
        },
      });
      polled += 1;
    } catch (error: unknown) {
      failed += 1;
      if (logger.isLevelEnabled("debug")) {
        logger.debug("agent_health_poll_failed", {
          agentId: agent.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { polled, skipped, failed };
};

export const startAgentHealthPollScheduler = (dispatch: AgentHealthPollDispatch): void => {
  if (pollTimer !== null) {
    return;
  }

  if (!env.agentHealthPollEnabled || env.agentHealthPollIntervalMs <= 0) {
    return;
  }

  dispatchCommand = dispatch;
  const intervalMs = Math.max(5_000, Math.floor(env.agentHealthPollIntervalMs));

  pollTimer = setInterval(() => {
    if (pollInFlight || dispatchCommand === null) {
      return;
    }
    pollInFlight = true;
    void runAgentHealthPollSweep(dispatchCommand)
      .then((summary) => {
        if (logger.isLevelEnabled("debug") && (summary.polled > 0 || summary.failed > 0)) {
          logger.debug("agent_health_poll_sweep", summary);
        }
      })
      .catch((error: unknown) => {
        logger.warn("agent_health_poll_sweep_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
  pollTimer.unref?.();
};

export const stopAgentHealthPollScheduler = (): void => {
  if (pollTimer === null) {
    return;
  }
  clearInterval(pollTimer);
  pollTimer = null;
  dispatchCommand = null;
  pollInFlight = false;
};

/** @internal test helper */
export const resetAgentHealthPollSchedulerForTests = (): void => {
  stopAgentHealthPollScheduler();
};
