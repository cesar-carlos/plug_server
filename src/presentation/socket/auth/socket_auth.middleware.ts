import type { Socket } from "socket.io";

import { unauthorized } from "../../../shared/errors/http_errors";
import { env } from "../../../shared/config/env";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { verifyAccessToken } from "../../../shared/utils/jwt";

import { ensureJwtUserAccountActive } from "./ensure_socket_active_account";

type AuthenticatedSocket = Socket & {
  data: {
    user?: JwtAccessPayload;
  };
};

export const authenticateSocket = async (
  socket: AuthenticatedSocket,
  next: (error?: Error) => void,
): Promise<void> => {
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

  if (!token) {
    if (env.socketAuthRequired) {
      next(unauthorized("Socket authentication token is required"));
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
  const okActive = await ensureJwtUserAccountActive(user, next);
  if (!okActive) {
    return;
  }

  socket.data.user = user;
  next();
};
