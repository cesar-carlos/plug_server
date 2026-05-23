import type { Socket } from "socket.io";

import { container } from "../../../shared/di/container";
import { unauthorized } from "../../../shared/errors/http_errors";
import { env } from "../../../shared/config/env";
import { incrementAuthSocketBlocked } from "../../../shared/metrics/auth_account.metrics";
import {
  noteConsumerSocketAuthRejected,
  observeSocketAuthAccountDbValidation,
} from "../../../shared/metrics/socket_consumer.metrics";
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

/** Coalesces concurrent DB validations on the same socket before `authSnapshot` is written. */
const inFlightValidationBySocketId = new Map<string, Promise<JwtAccessPayload>>();

export type AssertJwtUserAccountActiveOptions = {
  /** When true, increments consumer handshake/guard blocked-account metrics. */
  readonly recordConsumerBlockedMetric?: boolean;
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
  options?: AssertJwtUserAccountActiveOptions,
): Promise<JwtAccessPayload> => {
  const startedAt = performance.now();
  const result =
    user.principal_type === "client"
      ? await container.clientAuthService.getActiveClientSnapshot(
          user.sub,
          user.credentials_version,
        )
      : await container.authService.getActiveAccountUserSnapshot(
          user.sub,
          user.credentials_version,
        );
  observeSocketAuthAccountDbValidation(performance.now() - startedAt);
  if (!result.ok) {
    if (result.error.code === "FORBIDDEN" && result.error.message === "Account is blocked") {
      incrementAuthSocketBlocked();
      if (options?.recordConsumerBlockedMetric === true) {
        noteConsumerSocketAuthRejected("blocked_account");
      }
    }
    throw result.error;
  }
  return user;
};

/**
 * After JWT verification: rejects when the user is missing or `blocked` (same rules as HTTP).
 *
 * When `SOCKET_AUTH_ACCOUNT_SNAPSHOT_TTL_MS` > 0 and `socket` carries a recent matching
 * `authSnapshot`, skips the DB round-trip until the TTL expires (trade-off: block/unblock can
 * be observed later by up to that many ms).
 *
 * After each successful DB validation, refreshes `socket.data.authSnapshot` when `socket` is provided.
 *
 * Increments `plug_auth_socket_blocked_total` when denied due to blocked status.
 */
export const assertJwtUserAccountActive = async (
  user: JwtAccessPayload | undefined,
  socket?: SocketWithSnapshot,
  options?: AssertJwtUserAccountActiveOptions,
): Promise<JwtAccessPayload> => {
  if (!user?.sub) {
    throw unauthorized("Authentication required");
  }

  const ttlMs = env.socketAuthAccountSnapshotTtlMs;
  if (ttlMs > 0 && socket?.data.authSnapshot) {
    const snap = socket.data.authSnapshot;
    const expectedPrincipal: SocketAccountSnapshot["principalType"] =
      user.principal_type === "client" ? "client" : "user";
    const principalOk =
      snap.subjectId === user.sub &&
      snap.credentialsVersion === user.credentials_version &&
      snap.principalType === expectedPrincipal;
    if (principalOk && Date.now() - snap.validatedAtMs < ttlMs) {
      return user;
    }
  }

  if (socket?.id) {
    const inflight = inFlightValidationBySocketId.get(socket.id);
    if (inflight) {
      return inflight;
    }

    let resolveValidation!: (value: JwtAccessPayload) => void;
    let rejectValidation!: (reason?: unknown) => void;
    const validationPromise = new Promise<JwtAccessPayload>((resolve, reject) => {
      resolveValidation = resolve;
      rejectValidation = reject;
    });
    inFlightValidationBySocketId.set(socket.id, validationPromise);

    void (async () => {
      try {
        const validated = await validateActiveAccountAgainstDb(user, options);
        socket.data.authSnapshot = buildSnapshot(user);
        resolveValidation(validated);
      } catch (error: unknown) {
        rejectValidation(error);
      } finally {
        if (inFlightValidationBySocketId.get(socket.id) === validationPromise) {
          inFlightValidationBySocketId.delete(socket.id);
        }
      }
    })();

    return validationPromise;
  }

  const validated = await validateActiveAccountAgainstDb(user, options);
  if (socket) {
    socket.data.authSnapshot = buildSnapshot(user);
  }
  return validated;
};

export const ensureJwtUserAccountActive = async (
  user: JwtAccessPayload,
  next: (error?: Error) => void,
  socket?: SocketWithSnapshot,
  options?: AssertJwtUserAccountActiveOptions,
): Promise<boolean> => {
  try {
    await assertJwtUserAccountActive(user, socket, options);
  } catch (error: unknown) {
    next(error instanceof Error ? error : unauthorized("Authentication required"));
    return false;
  }

  return true;
};
