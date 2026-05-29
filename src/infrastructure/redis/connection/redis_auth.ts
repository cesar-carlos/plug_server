/**
 * Shared Redis auth/error helpers used by the single-client and pub/sub client
 * factories. Centralises:
 *
 *   - `toSafeRedisErrorMessage` — defensive `Error` → string.
 *   - `isRedisAuthError` — detects `WRONGPASS` / `NOAUTH` / `AUTH` failures
 *     surfaced by `node-redis` as `Error.message`.
 *   - `runRedisPostConnectAuthCheck` — the post-`connect()` `PING` that
 *     confirms credentials end-to-end, aborts hard in production on an auth
 *     failure, and records the `noteRedisAuthPing` outcome counter.
 *
 * Extracting these removes the copy that `instrumented_redis_client.ts` and
 * `pubsub_instrumented_redis_client.ts` each kept.
 */

import { noteRedisAuthPing } from "../../../application/services/redis_auth_ping_metrics.service";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";

export const toSafeRedisErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Detects Redis authentication failures (`WRONGPASS`, `NOAUTH`, `AUTH`).
 * `node-redis` surfaces them as `Error` whose `.message` matches one of:
 *   - `WRONGPASS invalid username-password pair or user is disabled.`
 *   - `NOAUTH Authentication required.`
 *   - `ERR Client sent AUTH, but no password is set...`
 */
export const isRedisAuthError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return /WRONGPASS|NOAUTH|Client sent AUTH/i.test(error.message ?? "");
};

export interface RedisPostConnectAuthCheckInput {
  /** Issues the `PING` (single client) — typically `() => client.ping()`. */
  readonly ping: () => Promise<unknown>;
  /** Stable module name for the auth-ping metric + log correlation. */
  readonly logName: string;
  /**
   * Tears down the connection(s) before a production auth abort. Implementations
   * should swallow their own quit errors (this helper does not).
   */
  readonly cleanup: () => Promise<void> | void;
}

/**
 * Post-connect AUTH validation. A `PING` after `connect()` confirms the
 * credentials work end-to-end (a misconfigured password fails here even if the
 * TCP handshake succeeded). We do not gate `connect()` itself on the ping —
 * that would re-introduce the unbounded boot stall the connectTimeout helper
 * exists to prevent. Instead we abort hard in production when the ping reveals
 * a `WRONGPASS`/`NOAUTH`; outside production we log and continue.
 */
export const runRedisPostConnectAuthCheck = async (
  input: RedisPostConnectAuthCheckInput,
): Promise<void> => {
  try {
    await input.ping();
    noteRedisAuthPing(input.logName, "ok");
  } catch (pingError: unknown) {
    const authError = isRedisAuthError(pingError);
    noteRedisAuthPing(input.logName, authError ? "auth_error" : "other_error");
    if (authError && env.nodeEnv === "production") {
      await input.cleanup();
      throw new Error(
        `${input.logName}: Redis authentication failed (${toSafeRedisErrorMessage(pingError)})`,
      );
    }
    logger.warn(`${input.logName}_post_connect_ping_failed`, {
      message: toSafeRedisErrorMessage(pingError),
      authError,
    });
  }
};
