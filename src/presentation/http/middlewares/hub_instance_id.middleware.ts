import type { NextFunction, Request, Response } from "express";

import { env } from "../../../shared/config/env";

/**
 * Resolved once at module load: an empty `HUB_INSTANCE_ID` keeps the middleware
 * a no-op (no header set), avoiding both an env lookup and a `setHeader` call
 * on the hot path. Operators flip the value at boot, so re-reading per request
 * would buy nothing and would defeat the fast no-op path.
 */
const hubInstanceId = env.hubInstanceId.trim();

/**
 * Adds `X-Hub-Instance-Id` to every response when `HUB_INSTANCE_ID` is set.
 *
 * Used by clients to validate sticky-session affinity behind multi-replica
 * deployments (consecutive REST calls from the same client must hit the same
 * hub instance) and to correlate hub-side logs/metrics across replicas.
 *
 * Mounted globally in `app.ts`; never gates the request, so a misconfigured
 * value cannot break traffic. Stays a no-op when the env var is empty.
 */
export const hubInstanceIdMiddleware = (
  _request: Request,
  response: Response,
  next: NextFunction,
): void => {
  if (hubInstanceId !== "") {
    response.setHeader("X-Hub-Instance-Id", hubInstanceId);
  }
  next();
};
