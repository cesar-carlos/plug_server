/**
 * Shared connection-lifecycle slot for the single-client Redis modules
 * (socket rate-limit, REST rate-limit, agent event stream, idempotency).
 *
 * Each module previously hand-rolled the same three pieces of state and the
 * generation-gating dance around them:
 *
 *   - `redisClient`         — the live connection (read on the hot path).
 *   - `redisUrlInUse`       — last URL connected to (skip re-init when unchanged).
 *   - `redisClientGeneration` + `isCurrent()` — guards listener callbacks so a
 *     stale generation never mutates live state after close/reconnect.
 *
 * This slot owns those three concerns and the `createInstrumentedRedisClient`
 * call, while the caller keeps its module-specific setup (Lua preload, read
 * replica, store registration, cluster-topology probe) and teardown. The hot
 * path reads `getClient()` (a single Map-free field read).
 */

import {
  createInstrumentedRedisClient,
  type InstrumentedRedisClient,
  type InstrumentedRedisClientCallbacks,
} from "./instrumented_redis_client";

export interface ManagedRedisConnectConfig {
  readonly url: string;
  readonly logName: string;
  readonly connectTimeoutMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  /**
   * Builds the listener callbacks. `isCurrent` is bound to the generation
   * captured for this connect attempt, so callbacks fired after a later
   * teardown/reconnect are ignored by the caller.
   */
  readonly buildCallbacks: (isCurrent: () => boolean) => InstrumentedRedisClientCallbacks;
}

export interface ManagedRedisConnectResult {
  readonly client: InstrumentedRedisClient;
  readonly isCurrent: () => boolean;
}

export interface ManagedRedisConnection {
  /** Live client, or `undefined` when disconnected (hot-path field read). */
  getClient(): InstrumentedRedisClient | undefined;
  /** `true` when a client is connected to exactly `url` (skip re-init guard). */
  isConnectedTo(url: string): boolean;
  /**
   * Bumps the generation, records `url`, connects, and stores the client on
   * success. Returns `{ client, isCurrent }` or `undefined` on connect failure
   * (the URL marker is cleared so the next init retries).
   */
  connect(config: ManagedRedisConnectConfig): Promise<ManagedRedisConnectResult | undefined>;
  /**
   * Synchronously bumps the generation (invalidating in-flight callbacks),
   * detaches the live client and clears the URL marker, returning the detached
   * client so the caller can fire-and-forget `quit()`. Use from sync paths
   * (e.g. a store-create failure) where awaiting `teardown` is not possible.
   */
  detach(): InstrumentedRedisClient | undefined;
  /**
   * Bumps the generation (invalidating in-flight callbacks), detaches and
   * quits the live client (best-effort), and clears the URL marker. Safe to
   * call when already disconnected.
   */
  teardown(): Promise<void>;
}

export const createManagedRedisConnection = (): ManagedRedisConnection => {
  let client: InstrumentedRedisClient | undefined;
  let urlInUse: string | undefined;
  let generation = 0;

  return {
    getClient: (): InstrumentedRedisClient | undefined => client,
    isConnectedTo: (url: string): boolean => client !== undefined && urlInUse === url,
    connect: async (
      config: ManagedRedisConnectConfig,
    ): Promise<ManagedRedisConnectResult | undefined> => {
      generation += 1;
      const currentGeneration = generation;
      urlInUse = config.url;
      const isCurrent = (): boolean => generation === currentGeneration;

      const connected = await createInstrumentedRedisClient({
        url: config.url,
        logName: config.logName,
        ...(config.connectTimeoutMs !== undefined
          ? { connectTimeoutMs: config.connectTimeoutMs }
          : {}),
        ...(config.reconnectBaseMs !== undefined
          ? { reconnectBaseMs: config.reconnectBaseMs }
          : {}),
        ...(config.reconnectMaxMs !== undefined ? { reconnectMaxMs: config.reconnectMaxMs } : {}),
        callbacks: config.buildCallbacks(isCurrent),
        isCurrent,
      });

      if (connected === undefined) {
        urlInUse = undefined;
        return undefined;
      }
      client = connected;
      return { client: connected, isCurrent };
    },
    detach: (): InstrumentedRedisClient | undefined => {
      generation += 1;
      const live = client;
      client = undefined;
      urlInUse = undefined;
      return live;
    },
    teardown: async (): Promise<void> => {
      generation += 1;
      const live = client;
      client = undefined;
      urlInUse = undefined;
      if (live !== undefined) {
        try {
          await live.quit();
        } catch {
          /* ignore */
        }
      }
    },
  };
};
