/**
 * AUTH ping outcomes for every Redis-backed module that runs through
 * `instrumented_redis_client.ts` or `pubsub_instrumented_redis_client.ts`.
 *
 * `outcome` taxonomy:
 *
 *   - `ok`            — `PING` returned `PONG`, credentials valid.
 *   - `auth_error`    — `WRONGPASS`/`NOAUTH`/`AUTH` failure. In production
 *                       this also aborts boot; the metric records the event
 *                       so dashboards detect misconfigured staging too.
 *   - `other_error`   — `PING` failed for non-auth reasons (timeout, TCP
 *                       reset). Logged at WARN level; module continues.
 *
 * `module` mirrors the `logName` passed to the factory (e.g.
 * `socket_rate_limit_redis`, `socket_io_redis_adapter`).
 */

export type RedisAuthPingOutcome = "ok" | "auth_error" | "other_error";

const counter = new Map<string, number>();

const buildKey = (module: string, outcome: RedisAuthPingOutcome): string => `${module}|${outcome}`;

export const noteRedisAuthPing = (module: string, outcome: RedisAuthPingOutcome): void => {
  const key = buildKey(module, outcome);
  counter.set(key, (counter.get(key) ?? 0) + 1);
};

export interface RedisAuthPingMetricsSnapshotEntry {
  readonly module: string;
  readonly outcome: RedisAuthPingOutcome;
  readonly count: number;
}

export const getRedisAuthPingMetricsSnapshot = (): readonly RedisAuthPingMetricsSnapshotEntry[] => {
  const entries: RedisAuthPingMetricsSnapshotEntry[] = [];
  for (const [key, count] of counter) {
    const [module, outcome] = key.split("|", 2);
    if (module === undefined || outcome === undefined) {
      continue;
    }
    entries.push({
      module,
      outcome: outcome as RedisAuthPingOutcome,
      count,
    });
  }
  return entries;
};

export const resetRedisAuthPingMetricsForTests = (): void => {
  counter.clear();
};
