import type { Request, Response } from "express";

import { env } from "../../../shared/config/env";
import { container } from "../../../shared/di/container";
import { logger } from "../../../shared/utils/logger";
import { nowUtcIso } from "../../../shared/utils/date";

interface BaseHealthPayload {
  readonly status: "ok" | "degraded";
  readonly service: string;
  readonly environment: string;
  readonly timestamp: string;
  readonly uptimeInSeconds: number;
  readonly requestId: string | undefined;
}

const buildBaseHealthPayload = (response: Response, status: "ok" | "degraded"): BaseHealthPayload =>
  ({
    status,
    service: env.appName,
    environment: env.nodeEnv,
    timestamp: nowUtcIso(),
    uptimeInSeconds: Math.floor(process.uptime()),
    requestId: response.locals.requestId as string | undefined,
  }) as const;

/**
 * Liveness check: only confirms the Node process is up and the event loop is
 * able to run a handler. **Must not** depend on external systems - orchestrators
 * use this to decide whether to restart the container, and a flaky DB should
 * not trigger pod restarts (use readiness for that).
 */
export const getHealthLive = (_request: Request, response: Response): void => {
  response.status(200).json({
    ...buildBaseHealthPayload(response, "ok"),
    mode: "live",
  });
};

type ReadinessResult = Awaited<ReturnType<typeof container.healthReadinessService.check>>;

/**
 * Cached probe result so concurrent checkers (k8s liveness + nginx upstream
 * health + LB target group + external monitors) do not stack DB connections
 * during transient slowness. TTL is intentionally short (1s) so the readiness
 * signal still reacts quickly to incidents.
 */
const readinessCacheTtlMs = 1_000;
let readinessCache: { result: ReadinessResult; expiresAtMs: number } | null = null;
let readinessInFlight: Promise<ReadinessResult> | null = null;

const fetchReadinessCached = async (): Promise<{
  result: ReadinessResult;
  cacheHit: boolean;
}> => {
  const nowMs = Date.now();
  const cached = readinessCache;
  if (cached && cached.expiresAtMs > nowMs) {
    return { result: cached.result, cacheHit: true };
  }
  /**
   * Coalesce concurrent probes: only the first caller hits the DB; everyone
   * else awaits the same in-flight promise. Avoids the thundering-herd when
   * multiple monitors poll simultaneously after a TTL window expires.
   */
  if (readinessInFlight === null) {
    readinessInFlight = container.healthReadinessService
      .check()
      .then((result) => {
        readinessCache = { result, expiresAtMs: Date.now() + readinessCacheTtlMs };
        return result;
      })
      .finally(() => {
        readinessInFlight = null;
      });
  }
  const result = await readinessInFlight;
  return { result, cacheHit: false };
};

/**
 * Readiness check: verifies the process can serve traffic right now. Used by
 * load balancers / Kubernetes to decide whether to route requests. We probe
 * Postgres through the application service with a short timeout because almost
 * every API surface needs the DB.
 *
 * Returns `503` with `status: "degraded"` so an upstream can stop sending
 * traffic to this replica until the DB recovers. Results are cached for 1s and
 * coalesced across concurrent callers so a `/health/ready` poll storm cannot
 * exhaust the DB connection pool.
 */
export const getHealthReady = async (_request: Request, response: Response): Promise<void> => {
  const { result: readiness, cacheHit } = await fetchReadinessCached();
  const ready = readiness.ready;
  const payload = {
    ...buildBaseHealthPayload(response, ready ? "ok" : "degraded"),
    mode: "ready",
    checks: {
      ...readiness.checks,
      /** Mirrors `SWAGGER_ENABLED`; if true but `/docs/*` 503s publicly, the edge proxy is misconfigured, not the app. */
      swaggerEnabled: env.swaggerEnabled,
    },
  };
  /**
   * Only log on cache miss so a polling storm against a degraded DB does not
   * inflate logs by 1× per checker × N replicas; the first miss in each TTL
   * window still surfaces the failure with its full context.
   */
  if (!ready && !cacheHit) {
    logger.warn("health_ready_db_probe_failed", {
      requestId: response.locals.requestId as string | undefined,
      error: readiness.checks.databaseError,
    });
  }
  response.status(ready ? 200 : 503).json(payload);
};

export const getHealth = (request: Request, response: Response): Promise<void> => {
  return getHealthReady(request, response);
};
