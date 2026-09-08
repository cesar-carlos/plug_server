import type { AnyRedisClientOptions } from "redis";

import { env } from "../../../shared/config/env";
import { resolveRedisUrlWithWarning } from "./redis_url_resolver";

/**
 * Builds resilient `node-redis` client options shared by every infrastructure
 * module that talks to Redis. Centralises:
 *
 * - `socket.connectTimeout` so the boot doesn't hang indefinitely on slow networks.
 * - `socket.reconnectStrategy` with capped exponential backoff so the client never
 *   silently gives up (the library default stops after ~20 attempts at 500 ms cap).
 *
 * Defaults come from `REDIS_DEFAULT_*` envs but each call site may override them
 * with values it already exposes (e.g. the Socket.IO adapter has its own envs
 * for backwards compatibility).
 */
export interface ResilientRedisClientOptionsInput {
  readonly url: string;
  readonly connectTimeoutMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  /**
   * Stable name used when logging the URL-shape warning produced by
   * `resolveRedisUrlWithWarning` (Sentinel and multi-host syntaxes). When
   * omitted, the resolver runs without logging.
   */
  readonly logName?: string;
}

const RECONNECT_RETRY_CAP = 8;

export const buildResilientRedisClientOptions = (
  input: ResilientRedisClientOptionsInput,
): AnyRedisClientOptions => {
  const connectTimeout = input.connectTimeoutMs ?? env.redisDefaultConnectTimeoutMs;
  const reconnectBase = input.reconnectBaseMs ?? env.redisDefaultReconnectBaseMs;
  const reconnectMax = input.reconnectMaxMs ?? env.redisDefaultReconnectMaxMs;

  const resolved = resolveRedisUrlWithWarning(input.url, input.logName ?? "redis_client");

  return {
    url: resolved.url,
    /**
     * node-redis@6 defaults to RESP3, which changes reply shapes for streams
     * and some module commands. Pin RESP2 so existing parsers and tests keep
     * the v5 wire format until a dedicated RESP3 migration.
     */
    RESP: 2,
    socket: {
      connectTimeout,
      reconnectStrategy: (retries: number): number => {
        const cappedRetries = Math.min(retries, RECONNECT_RETRY_CAP);
        const delay = reconnectBase * 2 ** cappedRetries;
        return Math.min(delay, reconnectMax);
      },
    },
  };
};
