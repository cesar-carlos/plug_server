import type { Request, RequestHandler, Response } from "express";
import { rateLimit, type Options } from "express-rate-limit";

import {
  incrementRestHttpAdminUserStatusRateLimitRejected,
  incrementRestHttpAgentsCommandsIpRateLimitRejected,
  incrementRestHttpAgentsCommandsUserRateLimitRejected,
  incrementRestHttpClientMeAgentsPostRateLimitRejected,
  incrementRestHttpGlobalRateLimitRejected,
} from "../../../application/services/rest_http_rate_limit_metrics.service";
import { env } from "../../../shared/config/env";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

const sendRateLimitResponse = async (
  request: Request,
  response: Response,
  optionsUsed: Options,
): Promise<void> => {
  response.status(optionsUsed.statusCode);
  const message =
    typeof optionsUsed.message === "function"
      ? await optionsUsed.message(request, response)
      : optionsUsed.message;
  if (!response.writableEnded) {
    response.send(message);
  }
};

export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
  handler: async (request, response, _next, optionsUsed) => {
    incrementRestHttpGlobalRateLimitRejected();
    await sendRateLimitResponse(request, response, optionsUsed);
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

const isTestEnv = (): boolean =>
  env.nodeEnv === "test" ||
  process.env.VITEST === "true" ||
  process.env.VITEST_WORKER_ID !== undefined;

const passthrough: RequestHandler = (_req, _res, next) => {
  next();
};

/**
 * Per-route limiter for **credential-handling** auth endpoints
 * (`/login`, `/register`, `/refresh`, `/agent-login`, `/registration/*`,
 * `/password-recovery/*`). Same budget as the legacy `authRateLimit` but
 * applied per-route so that authenticated routes such as `/auth/me`,
 * `/auth/password`, `/client-auth/me`, `/client-auth/password` are NOT
 * blanketed by it.
 *
 * Auto-bypasses inside the test runner so existing integration tests do not
 * have to wait/reset windows between test cases.
 */
export const credentialAuthRateLimit: RequestHandler = isTestEnv() ? passthrough : authRateLimit;

const agentsCommandsTooManyMessage = {
  message: "Too many agent commands, please try again later.",
  code: "TOO_MANY_REQUESTS",
};

const agentSelfProfileTooManyMessage = {
  message: "Too many agent profile updates, please try again later.",
  code: "TOO_MANY_REQUESTS",
};

/** Rate-limit store key for `POST /agents/commands` when limiting by `req.ip`. */
export const agentsCommandsIpRateLimitKey = (req: Request): string =>
  `agents_commands:ip:${req.ip ?? "unknown"}`;

/** Rate-limit store key for `POST /agents/commands` when limiting by JWT `sub` (after auth; typically `requireAuthAndActiveAccount`). */
export const agentsCommandsUserRateLimitKey = (res: Response): string => {
  const authUser = res.locals.authUser as JwtAccessPayload | undefined;
  const sub = authUser?.sub?.trim();
  return sub ? `agents_commands:user:${sub}` : "agents_commands:user:anonymous";
};

/** Rate-limit store key for admin `PATCH /admin/users/:id/status` (after auth; keyed by admin JWT `sub`). */
export const adminUserStatusRateLimitKey = (res: Response): string => {
  const authUser = res.locals.authUser as JwtAccessPayload | undefined;
  const sub = authUser?.sub?.trim();
  return sub ? `admin_user_status:${sub}` : "admin_user_status:anonymous";
};

/** Rate-limit store key for `POST /client/me/agents` keyed by client JWT `sub` (after `requireClientAuthAndActiveAccount`). */
export const clientMeAgentsPostRateLimitKey = (res: Response): string => {
  const authClient = res.locals.authClient as JwtAccessPayload | undefined;
  const sub = authClient?.sub?.trim();
  return sub ? `client_me_agents_post:${sub}` : "client_me_agents_post:anonymous";
};

/** Rate-limit store key for `PATCH /agents/:agentId/profile` keyed by authenticated user and bound agent claim. */
export const agentsSelfProfileRateLimitKey = (res: Response): string => {
  const authUser = res.locals.authUser as JwtAccessPayload | undefined;
  const sub = authUser?.sub?.trim();
  const agentId = authUser?.agent_id?.trim();
  if (sub && agentId) {
    return `agents_self_profile:user:${sub}:${agentId}`;
  }
  if (sub) {
    return `agents_self_profile:user:${sub}`;
  }
  return "agents_self_profile:anonymous";
};

/**
 * Optional per-IP cap on `POST /agents/commands` (same window as user limiter).
 * Disabled when `REST_AGENTS_COMMANDS_RATE_LIMIT_IP_MAX` is `0`.
 * Runs after JWT auth (and active-account check); use Express `trust proxy` so `req.ip` reflects the client behind proxies.
 */
export const agentsCommandsIpRateLimit: RequestHandler =
  env.restAgentsCommandsRateLimitIpMax > 0
    ? rateLimit({
        windowMs: env.restAgentsCommandsRateLimitWindowMs,
        limit: env.restAgentsCommandsRateLimitIpMax,
        standardHeaders: true,
        legacyHeaders: false,
        message: agentsCommandsTooManyMessage,
        keyGenerator: (req: Request) => agentsCommandsIpRateLimitKey(req),
        handler: async (request, response, _next, optionsUsed) => {
          incrementRestHttpAgentsCommandsIpRateLimitRejected();
          await sendRateLimitResponse(request, response, optionsUsed);
        },
      })
    : (((_req: Request, _res: Response, next) => {
        next();
      }) as RequestHandler);

/**
 * Per authenticated user (`JWT sub`) on `POST /agents/commands`.
 * Must run after auth middleware so `response.locals.authUser` is set.
 */
export const agentsCommandsUserRateLimit = rateLimit({
  windowMs: env.restAgentsCommandsRateLimitWindowMs,
  limit: env.restAgentsCommandsRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: agentsCommandsTooManyMessage,
  keyGenerator: (_req: Request, res: Response) => agentsCommandsUserRateLimitKey(res),
  handler: async (request, response, _next, optionsUsed) => {
    incrementRestHttpAgentsCommandsUserRateLimitRejected();
    await sendRateLimitResponse(request, response, optionsUsed);
  },
});

/**
 * Per authenticated agent on `PATCH /agents/:agentId/profile`.
 * Reuses the same window/max defaults as the agent command bridge but keeps an independent bucket.
 */
export const agentsSelfProfileRateLimit = rateLimit({
  windowMs: env.restAgentsCommandsRateLimitWindowMs,
  limit: env.restAgentsCommandsRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: agentSelfProfileTooManyMessage,
  keyGenerator: (_req: Request, res: Response) => agentsSelfProfileRateLimitKey(res),
  handler: async (request, response, _next, optionsUsed) => {
    await sendRateLimitResponse(request, response, optionsUsed);
  },
});

/** @deprecated Use `agentsCommandsUserRateLimit` (and optionally `agentsCommandsIpRateLimit`). */
export const agentsCommandsRateLimit = agentsCommandsUserRateLimit;

/**
 * Per admin (`JWT sub`) on `PATCH /admin/users/:id/status`.
 * Runs after JWT + active-account middleware so `response.locals.authUser` is set.
 */
export const adminUserStatusRateLimit = rateLimit({
  windowMs: env.restAdminUserStatusRateLimitWindowMs,
  limit: env.restAdminUserStatusRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many user status updates, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
  keyGenerator: (_req: Request, res: Response) => adminUserStatusRateLimitKey(res),
  handler: async (request, response, _next, optionsUsed) => {
    incrementRestHttpAdminUserStatusRateLimitRejected();
    await sendRateLimitResponse(request, response, optionsUsed);
  },
});

const clientMeAgentsPostTooManyMessage = {
  message: "Too many client agent access requests, please try again later.",
  code: "TOO_MANY_REQUESTS",
};

/**
 * Per authenticated client (`JWT sub`) on `POST /client/me/agents`.
 * Runs after client auth + active-account middleware so `response.locals.authClient` is set.
 */
export const clientMeAgentsPostRateLimit = rateLimit({
  windowMs: env.restClientMeAgentsPostRateLimitWindowMs,
  limit: env.restClientMeAgentsPostRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: clientMeAgentsPostTooManyMessage,
  keyGenerator: (_req: Request, res: Response) => clientMeAgentsPostRateLimitKey(res),
  handler: async (request, response, _next, optionsUsed) => {
    incrementRestHttpClientMeAgentsPostRateLimitRejected();
    await sendRateLimitResponse(request, response, optionsUsed);
  },
});

export const clientThumbnailRateLimit = rateLimit({
  windowMs: env.restClientThumbnailRateLimitWindowMs,
  limit: env.restClientThumbnailRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many thumbnail uploads, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

export const clientPasswordRecoveryRequestRateLimit = rateLimit({
  windowMs: env.restClientPasswordRecoveryRateLimitWindowMs,
  limit: env.restClientPasswordRecoveryRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many password recovery requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});
