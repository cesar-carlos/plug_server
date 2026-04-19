import { env } from "./env";
import { logger } from "../utils/logger";

export type SocketConsumerBootstrapEnvSlice = {
  readonly socketConsumerRoles: readonly string[];
  readonly socketClientAgentProfilePushEnabled: boolean;
};

/**
 * One-shot hints at process boot for Colmeia-style `/consumers` + profile push.
 * Does not alter parsed env — operators must fix `.env` + restart.
 */
export const logSocketConsumerBootstrapHints = (
  slice: SocketConsumerBootstrapEnvSlice = {
    socketConsumerRoles: env.socketConsumerRoles,
    socketClientAgentProfilePushEnabled: env.socketClientAgentProfilePushEnabled,
  },
): void => {
  if (!slice.socketConsumerRoles.includes("client")) {
    logger.warn("socket_consumer_roles_missing_client_role", {
      configuredRoles: slice.socketConsumerRoles,
      remediation:
        "Include literal role 'client' in SOCKET_CONSUMER_ROLES (e.g. user,admin,client) or remove the variable to inherit the schema default, then restart.",
    });
  }

  if (!slice.socketClientAgentProfilePushEnabled) {
    logger.warn("socket_client_agent_profile_push_disabled", {
      remediation:
        "Set SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED=true or unset it (default true), then restart, so approved clients receive client:agent.profile.updated on /consumers.",
    });
  }
};
