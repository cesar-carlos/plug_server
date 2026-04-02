/**
 * Namespace-specific socket authentication.
 * Enforces role/claim per namespace to prevent cross-role connections.
 */

import type { Socket } from "socket.io";

import { forbidden, unauthorized } from "../../../shared/errors/http_errors";
import { env } from "../../../shared/config/env";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { verifyAccessToken } from "../../../shared/utils/jwt";

import { ensureJwtUserAccountActive } from "./ensure_socket_active_account";

type AuthenticatedSocket = Socket & {
  data: {
    user?: JwtAccessPayload;
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
    if (env.socketAuthRequired) {
      next(unauthorized("Socket authentication token is required for /agents"));
      return;
    }
    next();
    return;
  }

  const result = verifyAccessToken(token);

  if (!result.ok) {
    next(result.error);
    return;
  }

  const user = result.value;
  const role = resolveRole(user);

  if (!env.socketAgentRoles.includes(role)) {
    next(forbidden(`Role '${role}' is not allowed to connect to /agents`));
    return;
  }

  const okActive = await ensureJwtUserAccountActive(user, next);
  if (!okActive) {
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
    if (env.socketAuthRequired) {
      next(unauthorized("Socket authentication token is required for /consumers"));
      return;
    }
    next();
    return;
  }

  const result = verifyAccessToken(token);

  if (!result.ok) {
    next(result.error);
    return;
  }

  const user = result.value;
  const role = resolveRole(user);

  if (env.socketAgentRoles.includes(role)) {
    next(forbidden(`Role '${role}' cannot connect to /consumers`));
    return;
  }

  if (!env.socketConsumerRoles.includes(role)) {
    next(forbidden(`Role '${role}' is not allowed to connect to /consumers`));
    return;
  }

  const okActive = await ensureJwtUserAccountActive(user, next);
  if (!okActive) {
    return;
  }

  socket.data.user = user;
  next();
};
