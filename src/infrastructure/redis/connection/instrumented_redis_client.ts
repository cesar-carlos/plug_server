import { createClient } from "redis";

import { logger } from "../../../shared/utils/logger";
import { buildResilientRedisClientOptions } from "./redis_client_options";
import { runRedisPostConnectAuthCheck, toSafeRedisErrorMessage } from "./redis_auth";

export type InstrumentedRedisClient = ReturnType<typeof createClient>;

export interface InstrumentedRedisClientCallbacks {
  /** Invoked once after the initial successful `connect()`. */
  readonly onConnected: () => void;
  /**
   * Invoked when the client emits a runtime `error`. Implementations should
   * be idempotent because the `error` event can fire multiple times during
   * a single TCP failure window.
   */
  readonly onError: (err: Error) => void;
  /** Invoked when the client emits `end` (TCP socket closed). */
  readonly onEnd: () => void;
  /**
   * Invoked when the initial `connect()` failed. The client is already torn
   * down (`quit`) before this fires.
   */
  readonly onFallback: (error: unknown) => void;
  /**
   * Optional handler for `node-redis` `ready` events fired AFTER the initial
   * connect (re-readiness after auto-reconnect). Initial readiness should be
   * handled in `onConnected`. The boolean argument is `true` when the event
   * fires post-initial-connect, mirroring the legacy `initialConnectSucceeded`
   * gate every module used to maintain.
   */
  readonly onReadyAfterReconnect?: () => void;
}

export interface InstrumentedRedisClientInput {
  readonly url: string;
  readonly logName: string;
  readonly connectTimeoutMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly callbacks: InstrumentedRedisClientCallbacks;
  /**
   * Optional `isCurrent` predicate used to gate listener handlers so that
   * stale callbacks from a previous generation never mutate live state. The
   * caller increments its own generation token and provides this predicate.
   */
  readonly isCurrent?: () => boolean;
}

/**
 * Centralises the boilerplate every Redis-backed module repeats: build a
 * resilient client, wire `error`/`end` listeners (gated by an optional
 * `isCurrent` predicate), `connect()`, and translate connection failure into
 * a fallback callback. Returns the connected client on success or `undefined`
 * on initial connect failure (caller is responsible for any state cleanup).
 *
 * The Socket.IO adapter intentionally stays on its own implementation
 * because it manages two clients (`pub` + `sub.duplicate()`) and a custom
 * server-attach lifecycle.
 */
export const createInstrumentedRedisClient = async (
  input: InstrumentedRedisClientInput,
): Promise<InstrumentedRedisClient | undefined> => {
  const url = input.url.trim();
  if (url === "") {
    return undefined;
  }

  const isCurrent = input.isCurrent ?? ((): boolean => true);
  const client = createClient(
    buildResilientRedisClientOptions({
      url,
      logName: input.logName,
      ...(input.connectTimeoutMs !== undefined ? { connectTimeoutMs: input.connectTimeoutMs } : {}),
      ...(input.reconnectBaseMs !== undefined ? { reconnectBaseMs: input.reconnectBaseMs } : {}),
      ...(input.reconnectMaxMs !== undefined ? { reconnectMaxMs: input.reconnectMaxMs } : {}),
    }),
  );

  let initialConnectSucceeded = false;

  client.on("error", (err: Error) => {
    if (!isCurrent()) {
      return;
    }
    logger.error(`${input.logName}_client_error`, { message: err.message });
    input.callbacks.onError(err);
  });
  client.on("end", () => {
    if (!isCurrent()) {
      return;
    }
    input.callbacks.onEnd();
  });
  if (input.callbacks.onReadyAfterReconnect !== undefined) {
    const onReadyAfterReconnect = input.callbacks.onReadyAfterReconnect;
    client.on("ready", () => {
      if (!isCurrent()) {
        return;
      }
      if (initialConnectSucceeded) {
        onReadyAfterReconnect();
      }
    });
  }

  try {
    await client.connect();
    initialConnectSucceeded = true;
  } catch (error: unknown) {
    logger.warn(`${input.logName}_fallback_memory`, {
      message: toSafeRedisErrorMessage(error),
    });
    void client.quit().catch(() => undefined);
    input.callbacks.onFallback(error);
    return undefined;
  }

  await runRedisPostConnectAuthCheck({
    ping: () => client.ping(),
    logName: input.logName,
    cleanup: () => {
      void client.quit().catch(() => undefined);
    },
  });
  input.callbacks.onConnected();
  return client;
};
