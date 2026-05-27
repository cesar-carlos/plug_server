import type { Request, Response } from "express";

import { getAgentEventStreamMetricsSnapshot } from "../../../application/services/agent_event_stream_metrics.service";
import { getClientSocketEventIdempotencyRedisMetricsSnapshot } from "../../../application/services/client_socket_event_idempotency_redis_metrics.service";
import { getRestRateLimitRedisMetricsSnapshot } from "../../../application/services/rest_rate_limit_redis_metrics.service";
import { getSocketIoRedisAdapterMetricsSnapshot } from "../../../application/services/socket_io_redis_adapter_metrics.service";
import { getSocketRateLimitRedisMetricsSnapshot } from "../../../application/services/socket_rate_limit_redis_metrics.service";

interface RedisModuleHealth {
  /** `1` when the URL is configured and we successfully connected (or are connected now). */
  readonly active: boolean;
  /** Optional reason when not active (`skipped`, `circuit_open`, `disconnected`). */
  readonly reason?: string;
  /** Last connection event timestamp (ms). 0 = never. */
  readonly lastConnectionAtMs?: number;
  /** Last fallback event timestamp (ms). 0 = never. */
  readonly lastFallbackAtMs?: number;
  /** Circuit breaker state for modules that have one. */
  readonly circuitOpen?: boolean;
}

interface RedisHealthPayload {
  readonly status: "ok" | "degraded";
  readonly modules: {
    readonly adapter: RedisModuleHealth;
    readonly socketRateLimit: RedisModuleHealth;
    readonly restRateLimit: RedisModuleHealth;
    readonly idempotency: RedisModuleHealth;
    readonly agentEventStream: RedisModuleHealth;
  };
}

/**
 * Reasons we treat a module as **not unhealthy** even when its store is
 * inactive: the module is opt-in and the operator has not enabled it. These
 * mirror the `noteSkippedEmptyUrl` paths in each metrics service.
 */
const isSkipped = (snapshot: { redisUrlConfigured: 0 | 1 }): boolean =>
  snapshot.redisUrlConfigured === 0;

const buildAdapterHealth = (
  snapshot: ReturnType<typeof getSocketIoRedisAdapterMetricsSnapshot>,
): RedisModuleHealth => {
  if (isSkipped(snapshot)) {
    return { active: false, reason: "skipped" };
  }
  if (snapshot.redisAdapterActive === 1) {
    return {
      active: true,
      lastConnectionAtMs: snapshot.lastConnectionAtMs,
    };
  }
  return {
    active: false,
    reason: "disconnected",
    lastConnectionAtMs: snapshot.lastConnectionAtMs,
    lastFallbackAtMs: snapshot.lastFallbackAtMs,
  };
};

const buildRateLimitHealth = (snapshot: {
  redisUrlConfigured: 0 | 1;
  redisStoreActive: 0 | 1;
  circuitOpen: 0 | 1;
  lastConnectionAtMs: number;
  lastFallbackAtMs: number;
}): RedisModuleHealth => {
  if (isSkipped(snapshot)) {
    return { active: false, reason: "skipped" };
  }
  if (snapshot.circuitOpen === 1) {
    return {
      active: false,
      reason: "circuit_open",
      circuitOpen: true,
      lastFallbackAtMs: snapshot.lastFallbackAtMs,
      lastConnectionAtMs: snapshot.lastConnectionAtMs,
    };
  }
  if (snapshot.redisStoreActive === 1) {
    return {
      active: true,
      circuitOpen: false,
      lastConnectionAtMs: snapshot.lastConnectionAtMs,
    };
  }
  return {
    active: false,
    reason: "disconnected",
    circuitOpen: false,
    lastConnectionAtMs: snapshot.lastConnectionAtMs,
    lastFallbackAtMs: snapshot.lastFallbackAtMs,
  };
};

const buildIdempotencyHealth = (
  snapshot: ReturnType<typeof getClientSocketEventIdempotencyRedisMetricsSnapshot>,
): RedisModuleHealth => {
  if (isSkipped(snapshot)) {
    return { active: false, reason: "skipped" };
  }
  if (snapshot.redisStoreActive === 1) {
    return {
      active: true,
      lastConnectionAtMs: snapshot.lastConnectionAtMs,
    };
  }
  return {
    active: false,
    reason: "disconnected",
    lastConnectionAtMs: snapshot.lastConnectionAtMs,
    lastFallbackAtMs: snapshot.lastFallbackAtMs,
  };
};

const buildAgentEventStreamHealth = (
  snapshot: ReturnType<typeof getAgentEventStreamMetricsSnapshot>,
): RedisModuleHealth => {
  if (isSkipped(snapshot)) {
    return { active: false, reason: "skipped" };
  }
  if (snapshot.redisStoreActive === 1) {
    return {
      active: true,
      lastConnectionAtMs: snapshot.lastConnectionAtMs,
    };
  }
  return {
    active: false,
    reason: "disconnected",
    lastConnectionAtMs: snapshot.lastConnectionAtMs,
    lastFallbackAtMs: snapshot.lastFallbackAtMs,
  };
};

const aggregateStatus = (modules: RedisHealthPayload["modules"]): "ok" | "degraded" => {
  for (const m of Object.values(modules)) {
    if (!m.active && m.reason !== "skipped") {
      return "degraded";
    }
  }
  return "ok";
};

/**
 * GET /health/redis
 *
 * Per-module Redis liveness suitable for Kubernetes readiness probes that
 * want to differentiate Redis state from Postgres state. Always returns a
 * full module breakdown; HTTP status is 200 when every module is either
 * `active` or `skipped`, and 503 when any module is `disconnected` or in
 * `circuit_open`.
 */
export const getRedisHealth = (_request: Request, response: Response): void => {
  const modules = {
    adapter: buildAdapterHealth(getSocketIoRedisAdapterMetricsSnapshot()),
    socketRateLimit: buildRateLimitHealth(getSocketRateLimitRedisMetricsSnapshot()),
    restRateLimit: buildRateLimitHealth(getRestRateLimitRedisMetricsSnapshot()),
    idempotency: buildIdempotencyHealth(getClientSocketEventIdempotencyRedisMetricsSnapshot()),
    agentEventStream: buildAgentEventStreamHealth(getAgentEventStreamMetricsSnapshot()),
  };
  const status = aggregateStatus(modules);
  const payload: RedisHealthPayload = { status, modules };
  response.status(status === "ok" ? 200 : 503).json(payload);
};
