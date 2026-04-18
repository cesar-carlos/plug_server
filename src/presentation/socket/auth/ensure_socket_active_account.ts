import type { Socket } from "socket.io";

import { container } from "../../../shared/di/container";
import { unauthorized } from "../../../shared/errors/http_errors";
import { incrementAuthSocketBlocked } from "../../../shared/metrics/auth_account.metrics";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

/**
 * Per-socket metadata from the last successful `assertJwtUserAccountActive` run.
 * Stored on `socket.data.authSnapshot` after each DB-backed validation.
 */
export interface SocketAccountSnapshot {
  readonly subjectId: string;
  readonly principalType: "user" | "client";
  /**
   * `credentials_version` claim from the JWT used to populate the snapshot.
   * If the JWT changes (re-auth), the snapshot is considered stale.
   */
  readonly credentialsVersion: number | undefined;
  /** ms timestamp of the last DB-confirmed validation. */
  validatedAtMs: number;
}

type SocketWithSnapshot = Socket & {
  data: {
    user?: JwtAccessPayload;
    authSnapshot?: SocketAccountSnapshot;
  };
};

const buildSnapshot = (user: JwtAccessPayload): SocketAccountSnapshot => ({
  subjectId: user.sub,
  principalType: user.principal_type === "client" ? "client" : "user",
  credentialsVersion: user.credentials_version,
  validatedAtMs: Date.now(),
});

/**
 * Performs the actual DB-backed active-account check and throws on failure.
 * Uses the lightweight snapshot repository methods (no `password_hash` etc.).
 */
const validateActiveAccountAgainstDb = async (
  user: JwtAccessPayload,
): Promise<JwtAccessPayload> => {
  const result =
    user.principal_type === "client"
      ? await container.clientAuthService.getActiveClientSnapshot(user.sub)
      : await container.authService.getActiveAccountUserSnapshot(
          user.sub,
          user.credentials_version,
        );
  if (!result.ok) {
    if (result.error.code === "FORBIDDEN" && result.error.message === "Account is blocked") {
      incrementAuthSocketBlocked();
    }
    throw result.error;
  }
  return user;
};

/**
 * After JWT verification: rejects when the user is missing or `blocked` (same rules as HTTP).
 *
 * After each successful DB validation, refreshes `socket.data.authSnapshot` when
 * `socket` is provided (metadata for debugging/metrics). Account status is always
 * re-checked against the DB because admin block/unblock is not visible to the socket
 * layer without a query.
 *
 * Increments `plug_auth_socket_blocked_total` when denied due to blocked status.
 */
export const assertJwtUserAccountActive = async (
  user: JwtAccessPayload | undefined,
  socket?: SocketWithSnapshot,
): Promise<JwtAccessPayload> => {
  if (!user?.sub) {
    throw unauthorized("Authentication required");
  }

  const validated = await validateActiveAccountAgainstDb(user);

  if (socket) {
    socket.data.authSnapshot = buildSnapshot(user);
  }

  return validated;
};

export const ensureJwtUserAccountActive = async (
  user: JwtAccessPayload,
  next: (error?: Error) => void,
  socket?: SocketWithSnapshot,
): Promise<boolean> => {
  try {
    await assertJwtUserAccountActive(user, socket);
  } catch (error: unknown) {
    next(error instanceof Error ? error : unauthorized("Authentication required"));
    return false;
  }

  return true;
};
