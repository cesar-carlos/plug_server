import { env } from "./env";
import { logger } from "../utils/logger";

export type SocketConsumerBootstrapEnvSlice = {
  readonly socketConsumerRoles: readonly string[];
  readonly socketConsumerRolesClientAppended: boolean;
  readonly socketClientAgentProfilePushEnabled: boolean;
};

/**
 * One-shot hints at process boot for Colmeia-style `/consumers` + profile push.
 * `client` is appended at parse time when missing from `SOCKET_CONSUMER_ROLES` (see
 * `parseSocketConsumerRolesValue` in `env.ts`).
 */
export const logSocketConsumerBootstrapHints = (
  slice: SocketConsumerBootstrapEnvSlice = {
    socketConsumerRoles: env.socketConsumerRoles,
    socketConsumerRolesClientAppended: env.socketConsumerRolesClientAppended,
    socketClientAgentProfilePushEnabled: env.socketClientAgentProfilePushEnabled,
  },
): void => {
  if (slice.socketConsumerRolesClientAppended) {
    logger.info("socket_consumer_roles_ensured_client", {
      effectiveRoles: slice.socketConsumerRoles,
      message:
        "SOCKET_CONSUMER_ROLES omitted literal 'client'; it was appended so Colmeia JWTs (role=client) work on /consumers. Set user,admin,client explicitly in .env if you want the config to match the effective value.",
    });
  }

  if (!slice.socketClientAgentProfilePushEnabled) {
    logger.warn("socket_client_agent_profile_push_disabled", {
      remediation:
        "Set SOCKET_CLIENT_AGENT_PROFILE_PUSH_ENABLED=true or unset it (default true), then restart, so approved clients receive client:agent.profile.updated on /consumers.",
    });
  }
};
