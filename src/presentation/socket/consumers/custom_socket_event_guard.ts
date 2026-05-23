import type { Socket } from "socket.io";

import { AppError } from "../../../shared/errors/app_error";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import {
  assertJwtUserAccountActive,
  type SocketAccountSnapshot,
} from "../auth/ensure_socket_active_account";

type GuardSocket = Socket & {
  data: {
    user?: JwtAccessPayload;
    authSnapshot?: SocketAccountSnapshot;
  };
};

export const disconnectSocketAfterCustomSocketEventAuthFailure = (
  socket: Socket,
  error: AppError,
): void => {
  if (!socket.connected) {
    return;
  }
  socket.emit(
    socketEvents.appError,
    buildLegacySocketAppErrorPayload(error.code, error.message, error.statusCode),
  );
  socket.disconnect(true);
};

export const assertActiveClientCustomSocketEventPrincipal = async (
  socket: GuardSocket,
): Promise<string> => {
  const user = socket.data.user;
  await assertJwtUserAccountActive(user, socket, { recordConsumerBlockedMetric: true });
  if (user?.principal_type !== "client" || typeof user.sub !== "string" || user.sub.trim() === "") {
    throw new AppError("Only Client principals may use custom socket events", {
      statusCode: 403,
      code: "FORBIDDEN",
    });
  }
  return user.sub.trim();
};

export const handleCustomSocketEventAuthFailure = (error: unknown): AppError => {
  const appError =
    error instanceof AppError
      ? error
      : new AppError("Authentication required", {
          statusCode: 401,
          code: "UNAUTHORIZED",
        });
  return appError;
};

export const isTerminalCustomSocketEventAuthFailure = (error: AppError): boolean =>
  error.statusCode === 401 || error.statusCode === 403;

export const isNonClientCustomSocketEventPrincipalError = (error: AppError): boolean =>
  error.code === "FORBIDDEN" &&
  error.message === "Only Client principals may use custom socket events";
