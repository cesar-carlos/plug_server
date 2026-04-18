import cookieParser from "cookie-parser";
import cors, { type CorsOptions } from "cors";
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
import { credentialAuthRateLimit } from "./presentation/http/middlewares/rate_limit.middleware";
import { globalRateLimit } from "./presentation/http/middlewares/rate_limit.middleware";
import { requestIdMiddleware } from "./presentation/http/middlewares/request_id.middleware";
import { authRouter } from "./presentation/http/routes/auth.routes";
import { httpRouter } from "./presentation/http/routes";
import { env } from "./shared/config/env";

const buildCorsOptions = (): CorsOptions => {
  if (env.corsOrigins === "*") {
    return { origin: "*", credentials: false };
  }
  const allowed = new Set(env.corsOrigins);
  return {
    origin: (origin, callback) => {
      // Same-origin / non-browser requests have no Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    },
    credentials: true,
  };
};

export const createApp = (): Express => {
  const app = express();
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
  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(
    morgan(
      env.nodeEnv === "production"
        ? ":remote-addr :method :url :status :response-time ms req_id=:request-id"
        : ":method :url :status :response-time ms req_id=:request-id",
    ),
  );
  /** Fail-fast: throttle /api/v1 before JSON body parsing (reduces CPU on abusive traffic). */
  app.use("/api/v1", globalRateLimit);
  app.use(express.json({ limit: env.requestBodyLimit }));
  /**
   * `extended: false` uses the built-in querystring parser (no nested objects);
   * cuts attack surface vs `qs` since URL-encoded bodies are only used by the
   * HTML approval forms which carry flat `{ token, reason? }` payloads.
   */
  app.use(express.urlencoded({ extended: false, limit: env.requestBodyLimit }));
  app.use(cookieParser());
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

  /**
   * `/metrics` is mounted at root only and requires `admin` role so generic
   * authenticated users cannot scrape internal counters/gauges. The same
   * controller is also mounted under `/api/v1/metrics` (httpRouter) for
   * Swagger reachability and reuses the same guard.
   */
  app.get("/metrics", ...requireAuthAndActiveAccount, requireRole("admin"), getMetrics);

  app.use("/auth", authRouter);
  app.use("/api/v1", httpRouter);
  // Compat aliases were already mounted above; the credential rate limiter is
  // now applied per-route inside `authRouter` to scope it to credential-handling
  // endpoints only (login/register/refresh/etc), instead of blanketing every
  // `/auth/*` request such as `/auth/me` or `/auth/password`.
  void credentialAuthRateLimit;
  setupSwagger(app);

  app.use((_request, response) => {
    response.status(404).json({
      message: "Route not found",
      code: "ROUTE_NOT_FOUND",
      requestId: response.locals.requestId as string | undefined,
    });
  });
  app.use(errorMiddleware);

  return app;
};
