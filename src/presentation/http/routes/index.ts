import { Router } from "express";

import { getHealth, getHealthLive, getHealthReady } from "../controllers/health.controller";
import { validateRequest } from "../middlewares/validate.middleware";
import { healthQuerySchema } from "../validators/health.validator";
import { authRouter } from "./auth.routes";

export const httpRouter = Router();

httpRouter.use("/auth", authRouter);

/**
 * @openapi
 * /ping:
 *   get:
 *     summary: Ping
 *     description: Lightweight liveness check. Returns pong if the server is up.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Server is alive
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: pong
 */
httpRouter.get("/ping", (_request, response) => {
  response.status(200).json({ message: "pong" });
});

/**
 * @openapi
 * /health/live:
 *   get:
 *     summary: Liveness check endpoint
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Process is alive
 */
httpRouter.get("/health/live", getHealthLive);

/**
 * @openapi
 * /health/ready:
 *   get:
 *     summary: Readiness check endpoint
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Application is ready to receive traffic
 */
httpRouter.get("/health/ready", getHealthReady);

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Returns the current health status of the application, uptime, environment, and request ID.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Application is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 service:
 *                   type: string
 *                   example: plug_server
 *                 environment:
 *                   type: string
 *                   example: development
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 uptimeInSeconds:
 *                   type: number
 *                   example: 42
 *                 requestId:
 *                   type: string
 *                   example: 8d347a6c-6d9e-492f-a2a5-8bf9f0a48911
 */
httpRouter.get(
  "/health",
  validateRequest({
    query: healthQuerySchema,
  }),
  getHealth,
);
