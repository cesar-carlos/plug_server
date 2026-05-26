import { agentRegistry } from "./registries/agent_registry";

/**
 * Whether this hub process currently has the agent registered on `/agents` after `agent:register`
 * (same notion as `isAgentOnline` passed to `ClientAgentAccessService` live-profile deps).
 */
export const isAgentConnectedToHub = (agentId: string): boolean =>
  agentRegistry.findByAgentId(agentId) !== null;
