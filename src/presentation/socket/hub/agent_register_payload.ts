import type { AgentRegisterProfileSnapshot } from "../../../application/services/agent_profile_sync.service";
import type { AgentRegisterPayload } from "../../../shared/validators/agent_register";

type AgentCapabilities = AgentRegisterPayload["capabilities"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Whether the agent opted into the explicit `protocol_ready_ack` handshake
 * (defer profile sync until `agent:ready`). Accepts the flag on both the
 * top-level capabilities and the `extensions` bag, in camelCase and snake_case,
 * for cross-version agent compatibility.
 */
export const resolveRequiresExplicitProtocolReadyAck = (
  capabilities: AgentCapabilities,
): boolean => {
  const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : null;
  return (
    extensions?.protocolReadyAck === true ||
    extensions?.protocol_ready_ack === true ||
    capabilities.protocolReadyAck === true ||
    capabilities.protocol_ready_ack === true
  );
};

/**
 * Builds the optional profile snapshot carried by `agent:register`. Returns
 * `undefined` when any of `profile` / `profile_version` / `profile_updated_at`
 * is missing or when the timestamp is not a valid date (the registration then
 * proceeds without an inline snapshot and falls back to an RPC profile sync).
 */
export const resolveAgentRegisterProfileSnapshot = (payload: {
  readonly profile: Record<string, unknown> | undefined;
  readonly profile_version: number | undefined;
  readonly profile_updated_at: string | undefined;
}): AgentRegisterProfileSnapshot | undefined => {
  if (
    payload.profile === undefined ||
    payload.profile_version === undefined ||
    payload.profile_updated_at === undefined
  ) {
    return undefined;
  }
  const profileUpdatedAt = new Date(payload.profile_updated_at);
  if (Number.isNaN(profileUpdatedAt.getTime())) {
    return undefined;
  }
  return {
    profile: payload.profile,
    profileVersion: payload.profile_version,
    profileUpdatedAt,
  };
};
