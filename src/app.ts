import compression from "compression";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";

import { setupSwagger } from "./presentation/docs/swagger";
import { errorMiddleware } from "./presentation/http/middlewares/error.middleware";
import { getMetrics } from "./presentation/http/controllers/metrics.controller";
import {
  requireAuthAndActiveAccount,
  requireRole,
} from "./presentation/http/middlewares/auth.middleware";
import {
  credentialAuthRateLimit,
  globalRateLimit,
  loginRateLimit,
  registerHttpRateLimits,
  tokenRefreshRateLimit,
} from "./presentation/http/middlewares/rate_limit.middleware";
import { hubInstanceIdMiddleware } from "./presentation/http/middlewares/hub_instance_id.middleware";
import { jsonBodyParserForRoute } from "./presentation/http/middlewares/client_socket_event_json_body.middleware";
import { httpRedMetricsMiddleware } from "./presentation/http/middlewares/http_red_metrics.middleware";
import { requestIdMiddleware } from "./presentation/http/middlewares/request_id.middleware";
import { registerRootPublicRoutes } from "./presentation/http/routes/root_public.routes";
import { authRouter } from "./presentation/http/routes/auth.routes";
import { httpRouter } from "./presentation/http/routes";
import { buildHttpErrorResponseBody } from "./presentation/http/helpers/http_error_response";
import { buildCorsOptions } from "./shared/config/cors";
import { env } from "./shared/config/env";

export const createApp = (): Express => {
  registerHttpRateLimits();

  const app = express();
  /**
   * Defensive: helmet already removes `X-Powered-By`, but disabling at the
   * Express layer keeps the header out even if the helmet pipeline is bypassed
   * by a future refactor on a sub-router.
   */
  app.disable("x-powered-by");
  /**
   * Disable weak ETag generation to avoid leaking response shape and to keep
   * downstream caches from serving JSON responses incorrectly cached.
   */
  app.set("etag", false);
  /** Single reverse proxy hop (e.g. nginx) — required for correct `req.ip` and express-rate-limit when `X-Forwarded-For` is set. */
  app.set("trust proxy", env.httpTrustProxy ? 1 : false);

  morgan.token("request-id", (_request, response) => {
    const requestId = response.getHeader("x-request-id");
    return typeof requestId === "string" ? requestId : "unknown";
  });

  app.use(requestIdMiddleware);
  app.use(hubInstanceIdMiddleware);
  /**
   * RED metrics middleware: mounted right after the request-id middleware so
   * every request gets counted, including 401/403/404 and rate-limited
   * responses. Late-mounted middlewares (router-scoped) still resolve the
   * final `req.route.path` before the `finish` listener records the histogram.
   */
  app.use(httpRedMetricsMiddleware);
  app.use(helmet());
  app.use(cors(buildCorsOptions(env.corsOrigins)));
  /**
   * Gzip outgoing JSON/HTML/text/JS/CSS responses above 1 KiB when the client
   * advertises `Accept-Encoding: gzip` (or `deflate`). Honors the legacy
   * `x-no-compression` opt-out header used in some load tests.
   *
   * Coordinated with nginx (`gzip_proxied off;` upstream) so the edge does not
   * re-compress already-compressed payloads — see `docs/nginx_production.md`.
   *
   * Socket.IO traffic (`/socket.io/*`) bypasses Express entirely; `compression`
   * also skips `Cache-Control: no-store` and SSE (`text/event-stream`) by
   * default, leaving `/metrics` and any future streaming endpoint untouched.
   */
  app.use(
    compression({
      threshold: 1024,
      filter: (request, response) => {
        if (request.headers["x-no-compression"]) {
          return false;
        }
        return compression.filter(request, response);
      },
    }),
  );
  /**
   * `morgan` is dev/test only: it wraps `res.end` to measure response time and
   * writes synchronously to stdout. In production we rely on nginx
   * `access_log` (see `docs/nginx_production.md`) and structured app logs from
   * `shared/utils/logger`. The `x-request-id` response header still carries
   * the request correlation id for upstream/downstream tracing.
   */
  if (env.nodeEnv !== "production") {
    app.use(morgan(":method :url :status :response-time ms req_id=:request-id"));
  }
  /** Fail-fast: throttle /api/v1 before JSON body parsing (reduces CPU on abusive traffic). */
  app.use("/api/v1", globalRateLimit);
  /** Root auth compatibility alias should be throttled before JSON parsing as well. */
  app.use("/auth", globalRateLimit);
  app.use(jsonBodyParserForRoute);
  /**
   * `extended: false` uses the built-in querystring parser (no nested objects);
   * cuts attack surface vs `qs` since URL-encoded bodies are only used by the
   * HTML approval forms which carry flat `{ token, reason? }` payloads.
   */
  app.use(express.urlencoded({ extended: false, limit: env.requestBodyLimit }));
  app.use(
    "/uploads",
    express.static(path.resolve(env.uploadsDir), {
      etag: true,
      maxAge: "7d",
      immutable: true,
      dotfiles: "deny",
      fallthrough: false,
      index: false,
    }),
  );

  const assetsRoot = path.resolve(process.cwd(), "assets");
  app.use(
    "/assets",
    (request, response, next) => {
      const rel = request.path.startsWith("/") ? request.path.slice(1) : request.path;
      if (rel.split("/").some((segment) => segment.startsWith("."))) {
        response.status(404).type("text/plain").send("Not found");
        return;
      }
      next();
    },
    express.static(assetsRoot, {
      etag: true,
      maxAge: "7d",
      dotfiles: "deny",
      fallthrough: false,
      index: false,
    }),
  );
  registerRootPublicRoutes(app, assetsRoot);

  /**
   * `/metrics` is mounted at root only and requires `admin` role so generic
   * authenticated users cannot scrape internal counters/gauges. The same
   * controller is also mounted under `/api/v1/metrics` (httpRouter) for
   * Swagger reachability and reuses the same guard.
   */
  app.get(
    "/metrics",
    globalRateLimit,
    ...requireAuthAndActiveAccount,
    requireRole("admin"),
    getMetrics,
  );

  app.use("/auth", authRouter);
  app.use("/api/v1", httpRouter);
  // Compat aliases were already mounted above; credential and token-refresh
  // rate limiters are applied per-route inside `authRouter` / `clientAuthRouter`.
  void credentialAuthRateLimit;
  void loginRateLimit;
  void tokenRefreshRateLimit;
  setupSwagger(app);

  app.use((_request, response) => {
    response.status(404).json(
      buildHttpErrorResponseBody({
        message: "Route not found",
        code: "ROUTE_NOT_FOUND",
        requestId: response.locals.requestId as string | undefined,
      }),
    );
  });
  app.use(errorMiddleware);

  return app;
};
