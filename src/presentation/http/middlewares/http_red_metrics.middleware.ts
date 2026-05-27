import type { Request, RequestHandler, Response } from "express";

import {
  decrementHttpInFlight,
  incrementHttpInFlight,
  recordHttpRequest,
} from "../../../shared/metrics/http_red.metrics";

const NS_PER_SEC = 1_000_000_000;

const toSeconds = (start: bigint): number => {
  const diff = process.hrtime.bigint() - start;
  return Number(diff) / NS_PER_SEC;
};

/**
 * Resolves a low-cardinality route template for metrics labels. Express 5
 * populates `req.route.path` after routing; on 404/error paths `req.route`
 * is undefined, so we fall back to a coarse bucket ("unmatched") instead of
 * the raw URL to avoid cardinality explosion from random IDs in URLs.
 */
const resolveRouteTemplate = (request: Request): string => {
  const baseUrl = typeof request.baseUrl === "string" ? request.baseUrl : "";
  const routePath =
    request.route && typeof request.route.path === "string" ? request.route.path : undefined;
  if (routePath !== undefined && routePath !== "") {
    return `${baseUrl}${routePath}`;
  }
  return "unmatched";
};

/**
 * RED metrics middleware: counts HTTP requests, observes duration per
 * `method|route|status_bucket` and tracks in-flight requests per route. Mount
 * early in the global stack (after `requestIdMiddleware`, before the
 * authentication middlewares) so even 401/403/404 paths are recorded.
 *
 * Uses `res.on("finish")` + `res.on("close")` so client-aborted requests are
 * still observed (status 499 mapping out of scope; we record the latest known
 * `statusCode`).
 */
export const httpRedMetricsMiddleware: RequestHandler = (request, response, next) => {
  /**
   * `req.route` is only populated when Express matches a router-level route;
   * for global middlewares that fire before the router (rate-limit reject,
   * for instance), we increment in-flight against `unmatched` and rely on the
   * `finish`/`close` listener to finalize the same key.
   */
  let inFlightLabel = "unmatched";
  const inFlightMethod = request.method;
  incrementHttpInFlight(inFlightMethod, inFlightLabel);

  const start = process.hrtime.bigint();
  let finalized = false;

  const finalize = (res: Response): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    const route = resolveRouteTemplate(request);
    decrementHttpInFlight(inFlightMethod, inFlightLabel);
    if (route !== inFlightLabel) {
      /**
       * The route template was only known after the matched router resolved
       * `req.route`; we already decremented the unmatched counter above, so
       * there is no second decrement needed here. The histogram and counter
       * are recorded against the final, low-cardinality route.
       */
      inFlightLabel = route;
    }
    recordHttpRequest({
      method: inFlightMethod,
      route,
      status: res.statusCode,
      durationSeconds: toSeconds(start),
    });
  };

  response.on("finish", () => finalize(response));
  response.on("close", () => finalize(response));

  next();
};
