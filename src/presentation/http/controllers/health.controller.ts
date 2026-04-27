import type { Request, Response } from "express";

import { prismaClient } from "../../../infrastructure/database/prisma/client";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";
import { nowUtcIso } from "../../../shared/utils/date";

const READINESS_DB_TIMEOUT_MS = 1_500;

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
 * able to run a handler. **Must not** depend on external systems — orchestrators
 * use this to decide whether to restart the container, and a flaky DB should
 * not trigger pod restarts (use readiness for that).
 */
export const getHealthLive = (_request: Request, response: Response): void => {
  response.status(200).json({
    ...buildBaseHealthPayload(response, "ok"),
    mode: "live",
  });
};

const probeDatabaseReady = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
  // In test runs the DI container uses in-memory repositories and there is no
  // guarantee a Postgres instance is reachable. Skip the probe so the readiness
  // endpoint can be exercised by integration tests without provisioning a DB.
  if (env.nodeEnv === "test") {
    return { ok: true };
  }
  const probe = prismaClient.$queryRawUnsafe<unknown>("SELECT 1");
  try {
    await Promise.race([
      probe,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(`db_probe_timeout_${READINESS_DB_TIMEOUT_MS}ms`)),
          READINESS_DB_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Readiness check: verifies the process can serve traffic right now. Used by
 * load balancers / Kubernetes to decide whether to route requests. We probe
 * Postgres with a short timeout because almost every API surface needs the DB.
 *
 * Returns `503` with `status: "degraded"` so an upstream can stop sending
 * traffic to this replica until the DB recovers.
 */
export const getHealthReady = async (_request: Request, response: Response): Promise<void> => {
  const dbProbe = await probeDatabaseReady();
  const ready = dbProbe.ok;
  const payload = {
    ...buildBaseHealthPayload(response, ready ? "ok" : "degraded"),
    mode: "ready",
    checks: {
      envLoaded: true,
      /** Mirrors `SWAGGER_ENABLED` — if true but `/docs/*` 503s publicly, the edge proxy is misconfigured, not the app. */
      swaggerEnabled: env.swaggerEnabled,
      database: ready,
      ...(dbProbe.ok ? {} : { databaseError: dbProbe.error }),
    },
  };
  if (!ready) {
    logger.warn("health_ready_db_probe_failed", {
      requestId: response.locals.requestId as string | undefined,
      error: dbProbe.error,
    });
  }
  response.status(ready ? 200 : 503).json(payload);
};

export const getHealth = (request: Request, response: Response): Promise<void> => {
  return getHealthReady(request, response);
};
