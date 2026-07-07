/**
 * Namespace-specific socket authentication.
 * Enforces role/claim per namespace to prevent cross-role connections.
 */

import type { Socket } from "socket.io";

import { forbidden, unauthorized } from "../../../shared/errors/http_errors";
import { AppError } from "../../../shared/errors/app_error";
import { env } from "../../../shared/config/env";
import { noteConsumerSocketAuthRejected } from "../../../shared/metrics/socket_consumer.metrics";
import { noteAgentSocketAuthRejected } from "../../../shared/metrics/socket_agent.metrics";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { verifyAccessToken } from "../../../shared/utils/jwt";
import { logger } from "../../../shared/utils/logger";

import {
  assertJwtUserAccountActive,
  ensureJwtUserAccountActive,
} from "./ensure_socket_active_account";

import type { SocketAccountSnapshot } from "./ensure_socket_active_account";

type AuthenticatedSocket = Socket & {
  data: {
    user?: JwtAccessPayload;
    authSnapshot?: SocketAccountSnapshot;
  };
};

const getToken = (socket: Socket): string | undefined => {
  const authorizationHeader = socket.handshake.headers.authorization;
  const handshakeToken = socket.handshake.auth.token;

  const bearerToken =
    typeof authorizationHeader === "string" && authorizationHeader.startsWith("Bearer ")
      ? authorizationHeader.replace("Bearer ", "").trim()
      : undefined;

  const token =
    typeof handshakeToken === "string" && handshakeToken.trim() !== ""
      ? handshakeToken
      : bearerToken;

  return token;
};

const resolveRole = (user: JwtAccessPayload): string => {
  return typeof user.role === "string" && user.role.trim() !== "" ? user.role : "user";
};

/**
 * Authenticates connections to the /agents namespace.
 * Requires token and role in SOCKET_AGENT_ROLES (default: "agent").
 * If token has agent_id claim, it will be validated against agent:register payload.
 */
export const authenticateAgentSocket = async (
  socket: AuthenticatedSocket,
  next: (error?: Error) => void,
): Promise<void> => {
  const token = getToken(socket);

  if (!token) {
    if (env.socketAgentAuthBypassAllowed && env.nodeEnv === "test") {
      logger.warn("agent_socket_auth_bypass_used", {
        socketId: socket.id,
        ip: socket.handshake.address,
      });
      next();
      return;
    }
    if (env.socketAgentAuthBypassAllowed && env.nodeEnv !== "test") {
      logger.error("agent_socket_auth_bypass_blocked_outside_test", {
        socketId: socket.id,
        nodeEnv: env.nodeEnv,
      });
    }
    noteAgentSocketAuthRejected("missing_token");
    next(unauthorized("Socket authentication token is required for /agents"));
    return;
  }

  const result = verifyAccessToken(token);

  if (!result.ok) {
    noteAgentSocketAuthRejected("invalid_token");
    next(result.error);
    return;
  }

  const user = result.value;
  const role = resolveRole(user);

  if (!env.socketAgentRoles.includes(role)) {
    noteAgentSocketAuthRejected("role_denied");
    next(forbidden(`Role '${role}' is not allowed to connect to /agents`));
    return;
  }

  try {
    await assertJwtUserAccountActive(user, socket);
  } catch (error: unknown) {
    if (
      error instanceof AppError &&
      error.code === "FORBIDDEN" &&
      error.message === "Account is blocked"
    ) {
      noteAgentSocketAuthRejected("blocked_account");
    } else {
      noteAgentSocketAuthRejected("account_validation_error");
    }
    next(error instanceof Error ? error : unauthorized("Authentication required"));
    return;
  }

  socket.data.user = user;
  next();
};

/**
 * Authenticates connections to the /consumers namespace.
 * Requires token and role in SOCKET_CONSUMER_ROLES (default: "user", "admin", "client").
 * Rejects roles in SOCKET_AGENT_ROLES to prevent agents from posing as consumers.
 */
export const authenticateConsumerSocket = async (
  socket: AuthenticatedSocket,
  next: (error?: Error) => void,
): Promise<void> => {
  const token = getToken(socket);

  if (!token) {
    noteConsumerSocketAuthRejected("missing_token");
    next(unauthorized("Socket authentication token is required for /consumers"));
    return;
  }

  const result = verifyAccessToken(token);

  if (!result.ok) {
    noteConsumerSocketAuthRejected("invalid_token");
    next(result.error);
    return;
  }

  const user = result.value;
  const role = resolveRole(user);

  if (env.socketAgentRoles.includes(role)) {
    noteConsumerSocketAuthRejected("role_denied");
    next(forbidden(`Role '${role}' cannot connect to /consumers`));
    return;
  }

  if (!env.socketConsumerRoles.includes(role)) {
    noteConsumerSocketAuthRejected("role_denied");
    next(forbidden(`Role '${role}' is not allowed to connect to /consumers`));
    return;
  }

  const okActive = await ensureJwtUserAccountActive(user, next, socket, {
    recordConsumerBlockedMetric: true,
  });
  if (!okActive) {
    return;
  }

  socket.data.user = user;
  next();
};
