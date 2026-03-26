import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import morgan from "morgan";

import { setupSwagger } from "./presentation/docs/swagger";
import { errorMiddleware } from "./presentation/http/middlewares/error.middleware";
import { getMetrics } from "./presentation/http/controllers/metrics.controller";
import { requireAuth } from "./presentation/http/middlewares/auth.middleware";
import {
  authRateLimit,
  globalRateLimit,
} from "./presentation/http/middlewares/rate_limit.middleware";
import { requestIdMiddleware } from "./presentation/http/middlewares/request_id.middleware";
import { authRouter } from "./presentation/http/routes/auth.routes";
import { httpRouter } from "./presentation/http/routes";
import { env } from "./shared/config/env";

const authRateLimitDisabled: express.RequestHandler = (_req, _res, next) => {
  next();
};

export const createApp = (): Express => {
  const app = express();

  morgan.token("request-id", (_request, response) => {
    const requestId = response.getHeader("x-request-id");
    return typeof requestId === "string" ? requestId : "unknown";
  });

  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin,
      credentials: env.corsOrigin !== "*",
    }),
  );
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
  app.use(express.urlencoded({ extended: true, limit: env.requestBodyLimit }));
  app.use(cookieParser());

  app.get("/metrics", requireAuth, getMetrics);

  const authRl =
    env.nodeEnv === "test" || process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined
      ? authRateLimitDisabled
      : authRateLimit;
  app.use("/auth", authRl);
  app.use("/auth", authRouter);
  app.use("/api/v1/auth", authRl);
  app.use("/api/v1", httpRouter);
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
