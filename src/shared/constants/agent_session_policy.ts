/**
 * Hub policy when two sockets attempt `agent:register` for the same `agentId`
 * (same owning user). Parsed from `SOCKET_AGENT_SESSION_POLICY`.
 */
export const AGENT_SESSION_POLICIES = [
  "reject_active",
  "takeover_disconnect_previous",
  "legacy_silent_takeover",
] as const;

export type AgentSessionPolicy = (typeof AGENT_SESSION_POLICIES)[number];
