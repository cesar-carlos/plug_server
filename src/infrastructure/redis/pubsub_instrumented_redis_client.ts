import type { RedisClientOptions } from "redis";
import { createClient } from "redis";

import { noteRedisAuthPing } from "../../application/services/redis_auth_ping_metrics.service";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";
import type { InstrumentedRedisClient } from "./instrumented_redis_client";

/**
 * Pub/Sub flavour of the instrumented Redis client factory: creates the
 * `pub` client and a duplicated `sub` client (both required by
 * `@socket.io/redis-adapter`), wires `error`/`end` listeners gated by an
 * optional `isCurrent` predicate, connects in parallel, and reports
 * success/failure via callbacks.
 *
 * The single-client `instrumented_redis_client.ts` factory is unsuitable
 * because it manages exactly one connection. Extracting this paired
 * factory removes ~80 lines of duplicated cerimônia from
 * `socket_io_redis_adapter.ts`.
 */
export interface PubSubInstrumentedRedisClients {
  readonly pub: InstrumentedRedisClient;
  readonly sub: InstrumentedRedisClient;
  /** Quits both clients in parallel, swallowing per-client errors. */
  readonly close: () => Promise<void>;
}

export interface PubSubRoleError {
  readonly role: "pub" | "sub";
  readonly error: Error;
}

export interface PubSubInstrumentedRedisClientsCallbacks {
  /** Invoked once after BOTH clients connect successfully. */
  readonly onConnected: () => void;
  /** Per-client runtime error. Implementations should be idempotent. */
  readonly onError: (event: PubSubRoleError) => void;
  /** Per-client `end` (TCP socket closed). */
  readonly onEnd: (role: "pub" | "sub") => void;
  /** Initial parallel `connect()` failed; both clients are torn down. */
  readonly onFallback: (error: unknown) => void;
}

export interface PubSubInstrumentedRedisClientsInput {
  readonly url: string;
  readonly logName: string;
  /**
   * Builds the `RedisClientOptions` used for the `pub` client. The `sub`
   * client is built via `pub.duplicate()` so it inherits the same options.
   * Caller-provided builder so adapter-specific knobs (e.g. backoff envs
   * dedicated to the Socket.IO adapter) can override the defaults.
   */
  readonly buildClientOptions: () => RedisClientOptions;
  readonly callbacks: PubSubInstrumentedRedisClientsCallbacks;
  /**
   * Optional gate so listeners ignore stale callbacks after a generation
   * bump (close/reconnect). Mirrors `instrumented_redis_client`.
   */
  readonly isCurrent?: () => boolean;
}

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRedisAuthError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return /WRONGPASS|NOAUTH|Client sent AUTH/i.test(error.message ?? "");
};

export const createPubSubInstrumentedRedisClients = async (
  input: PubSubInstrumentedRedisClientsInput,
): Promise<PubSubInstrumentedRedisClients | undefined> => {
  const url = input.url.trim();
  if (url === "") {
    return undefined;
  }

  const isCurrent = input.isCurrent ?? ((): boolean => true);

  const options = input.buildClientOptions();
  const pub = createClient(options);
  const sub = pub.duplicate();

  const wireListeners = (client: InstrumentedRedisClient, role: "pub" | "sub"): void => {
    client.on("error", (err: Error) => {
      if (!isCurrent()) {
        return;
      }
      logger.error(`${input.logName}_client_error`, { role, message: err.message });
      input.callbacks.onError({ role, error: err });
    });
    client.on("end", () => {
      if (!isCurrent()) {
        return;
      }
      input.callbacks.onEnd(role);
    });
  };
  wireListeners(pub, "pub");
  wireListeners(sub, "sub");

  try {
    await Promise.all([pub.connect(), sub.connect()]);
  } catch (error: unknown) {
    logger.warn(`${input.logName}_fallback_memory`, {
      message: toSafeErrorMessage(error),
    });
    void pub.quit().catch(() => undefined);
    void sub.quit().catch(() => undefined);
    input.callbacks.onFallback(error);
    return undefined;
  }

  // Post-connect AUTH validation: pub-side ping is sufficient (sub uses the
  // same credentials via `pub.duplicate()`).
  try {
    await pub.ping();
    noteRedisAuthPing(input.logName, "ok");
  } catch (pingError: unknown) {
    const authError = isRedisAuthError(pingError);
    noteRedisAuthPing(input.logName, authError ? "auth_error" : "other_error");
    if (authError && env.nodeEnv === "production") {
      const message = `${input.logName}: Redis authentication failed (${toSafeErrorMessage(pingError)})`;
      void pub.quit().catch(() => undefined);
      void sub.quit().catch(() => undefined);
      throw new Error(message);
    }
    logger.warn(`${input.logName}_post_connect_ping_failed`, {
      message: toSafeErrorMessage(pingError),
      authError,
    });
  }

  input.callbacks.onConnected();
  return {
    pub,
    sub,
    close: async (): Promise<void> => {
      await Promise.allSettled([
        pub.quit().catch(() => undefined),
        sub.quit().catch(() => undefined),
      ]);
    },
  };
};
