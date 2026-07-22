import { env } from "../../../../shared/config/env";
import {
  getRelayAgentDispatchInflight,
  getRelayAgentDispatchQueueDepth,
} from "../relay/relay_agent_dispatch_queue";
import {
  getRestAgentDispatchInflight,
  getRestAgentDispatchQueueDepth,
} from "../relay/rest_agent_dispatch_queue";

/**
 * True when REST or relay dispatch is at inflight capacity or has waiters queued
 * (near capacity). Used to skip observability-only `agent.getHealth` polls so
 * saturated agents are not burdened further.
 */
export const shouldSkipAgentHealthPollDueToDispatchSaturation = (agentId: string): boolean => {
  if (env.socketRestAgentMaxInflight > 0) {
    const restInflight = getRestAgentDispatchInflight(agentId);
    if (restInflight >= env.socketRestAgentMaxInflight) {
      return true;
    }
    if (getRestAgentDispatchQueueDepth(agentId) > 0) {
      return true;
    }
  }

  if (env.socketRelayAgentMaxInflight > 0) {
    const relayInflight = getRelayAgentDispatchInflight(agentId);
    if (relayInflight >= env.socketRelayAgentMaxInflight) {
      return true;
    }
    if (getRelayAgentDispatchQueueDepth(agentId) > 0) {
      return true;
    }
  }

  return false;
};
