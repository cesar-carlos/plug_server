import { env } from "./env";
import { logger } from "../utils/logger";

export type SocketAuthBootstrapEnvSlice = {
  readonly nodeEnv: string;
  readonly socketAuthRequired: boolean;
  readonly socketAgentAuthBypassAllowed: boolean;
};

/**
 * One-shot hints at process boot for `/agents` handshake auth policy.
 * `SOCKET_AUTH_REQUIRED=false` is honored only when `NODE_ENV=test`.
 */
export const logSocketAuthBootstrapHints = (
  slice: SocketAuthBootstrapEnvSlice = {
    nodeEnv: env.nodeEnv,
    socketAuthRequired: env.socketAuthRequired,
    socketAgentAuthBypassAllowed: env.socketAgentAuthBypassAllowed,
  },
): void => {
  if (slice.socketAuthRequired) {
    return;
  }

  if (slice.socketAgentAuthBypassAllowed) {
    logger.warn("socket_agent_auth_bypass_test_only", {
      nodeEnv: slice.nodeEnv,
      message:
        "SOCKET_AUTH_REQUIRED=false allows anonymous /agents handshakes in NODE_ENV=test only. Production and development always require JWT.",
    });
    return;
  }

  logger.warn("socket_agent_auth_bypass_ignored", {
    nodeEnv: slice.nodeEnv,
    message:
      "SOCKET_AUTH_REQUIRED=false is ignored outside NODE_ENV=test. /agents handshakes still require JWT.",
  });
};
