import type { Socket } from "socket.io";

import { unauthorized } from "../../../shared/errors/http_errors";
import { env } from "../../../shared/config/env";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { verifyAccessToken } from "../../../shared/utils/jwt";

type AuthenticatedSocket = Socket & {
  data: {
    user?: JwtAccessPayload;
  };
};

export const authenticateSocket = (
  socket: AuthenticatedSocket,
  next: (error?: Error) => void,
): void => {
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

  socket.data.user = result.value;
  next();
};
