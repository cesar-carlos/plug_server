import { rateLimit } from "express-rate-limit";

import { env } from "../../../shared/config/env";

export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many authentication attempts, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

export const agentsCommandsRateLimit = rateLimit({
  windowMs: env.restAgentsCommandsRateLimitWindowMs,
  limit: env.restAgentsCommandsRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many agent commands, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});
