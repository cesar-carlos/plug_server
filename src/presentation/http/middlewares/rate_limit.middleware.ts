import type { Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";

import {
  incrementRestHttpAdminUserStatusRateLimitRejected,
  incrementRestHttpAgentsCommandsIpRateLimitRejected,
  incrementRestHttpAgentsCommandsUserRateLimitRejected,
  incrementRestHttpAgentsSelfProfileRateLimitRejected,
  incrementRestHttpClientMeAgentsPostRateLimitRejected,
  incrementRestHttpClientPasswordRecoveryRequestRateLimitRejected,
  incrementRestHttpClientThumbnailRateLimitRejected,
  incrementRestHttpCredentialAuthRateLimitRejected,
  incrementRestHttpGlobalRateLimitRejected,
  incrementRestHttpTokenRefreshRateLimitRejected,
} from "../../../application/services/rest_http_rate_limit_metrics.service";
import {
  createRestHttpRateLimitStore,
  type RestHttpRateLimitStoreScope,
} from "../../../infrastructure/redis/rest_rate_limit_redis";
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

const optionalRedisStore = (
  scope: RestHttpRateLimitStoreScope,
): Pick<Options, "passOnStoreError" | "store"> | undefined => {
  const store = createRestHttpRateLimitStore(scope);
  return store !== undefined ? { store, passOnStoreError: true } : undefined;
};

export const globalRateLimitNotRegistered: RequestHandler = (_req, res) => {
  res.status(500).json({
    message: "HTTP rate limiters not initialized (call registerHttpRateLimits).",
    code: "RATE_LIMIT_NOT_INITIALIZED",
  });
};

export let globalRateLimit: RequestHandler = globalRateLimitNotRegistered;

export let credentialAuthRateLimit: RequestHandler = globalRateLimitNotRegistered;

export let tokenRefreshRateLimit: RequestHandler = globalRateLimitNotRegistered;

export let agentsCommandsIpRateLimit: RequestHandler = globalRateLimitNotRegistered;

/** Per authenticated user (`JWT sub`) on `POST /agents/commands`. */
export let agentsCommandsUserRateLimit: RequestHandler = globalRateLimitNotRegistered;

/** @deprecated Same middleware as {@link agentsCommandsUserRateLimit}. */
export let agentsCommandsRateLimit: RequestHandler = globalRateLimitNotRegistered;

/** Per authenticated agent on `PATCH /agents/:agentId/profile`. */
export let agentsSelfProfileRateLimit: RequestHandler = globalRateLimitNotRegistered;

/** Per admin (`JWT sub`) on `PATCH /admin/users/:id/status`. */
export let adminUserStatusRateLimit: RequestHandler = globalRateLimitNotRegistered;

/** Per authenticated client (`JWT sub`) on `POST /client/me/agents`. */
export let clientMeAgentsPostRateLimit: RequestHandler = globalRateLimitNotRegistered;

export let clientThumbnailRateLimit: RequestHandler = globalRateLimitNotRegistered;

export let clientPasswordRecoveryRequestRateLimit: RequestHandler = globalRateLimitNotRegistered;

const agentsCommandsTooManyMessage = {
  message: "Too many agent commands, please try again later.",
  code: "TOO_MANY_REQUESTS",
};

const agentSelfProfileTooManyMessage = {
  message: "Too many agent profile updates, please try again later.",
  code: "TOO_MANY_REQUESTS",
};

/** Rate-limit store key for `POST /agents/commands` when limiting by `req.ip`. */
export const agentsCommandsIpRateLimitKey = (req: Request): string => {
  const ip = typeof req.ip === "string" && req.ip.trim() !== "" ? req.ip : "unknown";
  return `agents_commands:ip:${ipKeyGenerator(ip)}`;
};

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

const isTestEnv = (): boolean =>
  env.nodeEnv === "test" ||
  process.env.VITEST === "true" ||
  process.env.VITEST_WORKER_ID !== undefined;

const passthrough: RequestHandler = (_req, _res, next) => {
  next();
};

/**
 * Builds all `express-rate-limit` middlewares. Must run once before `createApp()` (after optional
 * {@link initRestHttpRateLimitRedis} in production). Vitest setup calls this from `tests/setup/vitest.rate_limits.ts`.
 *
 * For each `REST_*_RATE_LIMIT_MAX` (and related `REST_CLIENT_*` limits), **`0` means unlimited**
 * (middleware becomes a no-op for that route group).
 */
export function registerHttpRateLimits(): void {
  globalRateLimit =
    env.restGlobalRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restGlobalRateLimitWindowMs,
          limit: env.restGlobalRateLimitMax,
          ...(optionalRedisStore("global") ?? {}),
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

  const authRateLimit =
    env.restCredentialAuthRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restCredentialAuthRateLimitWindowMs,
          limit: env.restCredentialAuthRateLimitMax,
          ...(optionalRedisStore("credential_auth") ?? {}),
          standardHeaders: true,
          legacyHeaders: false,
          message: {
            message: "Too many authentication attempts, please try again later.",
            code: "TOO_MANY_REQUESTS",
          },
          handler: async (request, response, _next, optionsUsed) => {
            incrementRestHttpCredentialAuthRateLimitRejected();
            await sendRateLimitResponse(request, response, optionsUsed);
          },
        });

  const tokenRefreshAuthRateLimit =
    env.restTokenRefreshRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restTokenRefreshRateLimitWindowMs,
          limit: env.restTokenRefreshRateLimitMax,
          ...(optionalRedisStore("token_refresh") ?? {}),
          standardHeaders: true,
          legacyHeaders: false,
          message: {
            message: "Too many token refresh requests, please try again later.",
            code: "TOO_MANY_REQUESTS",
          },
          handler: async (request, response, _next, optionsUsed) => {
            incrementRestHttpTokenRefreshRateLimitRejected();
            await sendRateLimitResponse(request, response, optionsUsed);
          },
        });

  credentialAuthRateLimit = isTestEnv() ? passthrough : authRateLimit;
  tokenRefreshRateLimit = isTestEnv() ? passthrough : tokenRefreshAuthRateLimit;

  agentsCommandsIpRateLimit =
    env.restAgentsCommandsRateLimitIpMax > 0
      ? rateLimit({
          windowMs: env.restAgentsCommandsRateLimitWindowMs,
          limit: env.restAgentsCommandsRateLimitIpMax,
          ...(optionalRedisStore("agents_commands_ip") ?? {}),
          standardHeaders: true,
          legacyHeaders: false,
          message: agentsCommandsTooManyMessage,
          keyGenerator: (req: Request) => agentsCommandsIpRateLimitKey(req),
          handler: async (request, response, _next, optionsUsed) => {
            incrementRestHttpAgentsCommandsIpRateLimitRejected();
            await sendRateLimitResponse(request, response, optionsUsed);
          },
        })
      : passthrough;

  agentsCommandsUserRateLimit =
    env.restAgentsCommandsRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restAgentsCommandsRateLimitWindowMs,
          limit: env.restAgentsCommandsRateLimitMax,
          ...(optionalRedisStore("agents_commands_user") ?? {}),
          standardHeaders: true,
          legacyHeaders: false,
          message: agentsCommandsTooManyMessage,
          keyGenerator: (_req: Request, res: Response) => agentsCommandsUserRateLimitKey(res),
          handler: async (request, response, _next, optionsUsed) => {
            incrementRestHttpAgentsCommandsUserRateLimitRejected();
            await sendRateLimitResponse(request, response, optionsUsed);
          },
        });

  agentsSelfProfileRateLimit =
    env.restAgentsCommandsRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restAgentsCommandsRateLimitWindowMs,
          limit: env.restAgentsCommandsRateLimitMax,
          ...(optionalRedisStore("agents_self_profile") ?? {}),
          standardHeaders: true,
          legacyHeaders: false,
          message: agentSelfProfileTooManyMessage,
          keyGenerator: (_req: Request, res: Response) => agentsSelfProfileRateLimitKey(res),
          handler: async (request, response, _next, optionsUsed) => {
            incrementRestHttpAgentsSelfProfileRateLimitRejected();
            await sendRateLimitResponse(request, response, optionsUsed);
          },
        });

  adminUserStatusRateLimit =
    env.restAdminUserStatusRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restAdminUserStatusRateLimitWindowMs,
          limit: env.restAdminUserStatusRateLimitMax,
          ...(optionalRedisStore("admin_user_status") ?? {}),
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

  clientMeAgentsPostRateLimit =
    env.restClientMeAgentsPostRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restClientMeAgentsPostRateLimitWindowMs,
          limit: env.restClientMeAgentsPostRateLimitMax,
          ...(optionalRedisStore("client_me_agents_post") ?? {}),
          standardHeaders: true,
          legacyHeaders: false,
          message: {
            message: "Too many client agent access requests, please try again later.",
            code: "TOO_MANY_REQUESTS",
          },
          keyGenerator: (_req: Request, res: Response) => clientMeAgentsPostRateLimitKey(res),
          handler: async (request, response, _next, optionsUsed) => {
            incrementRestHttpClientMeAgentsPostRateLimitRejected();
            await sendRateLimitResponse(request, response, optionsUsed);
          },
        });

  clientThumbnailRateLimit =
    env.restClientThumbnailRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restClientThumbnailRateLimitWindowMs,
          limit: env.restClientThumbnailRateLimitMax,
          ...(optionalRedisStore("client_thumbnail") ?? {}),
          standardHeaders: true,
          legacyHeaders: false,
          message: {
            message: "Too many thumbnail uploads, please try again later.",
            code: "TOO_MANY_REQUESTS",
          },
          handler: async (request, response, _next, optionsUsed) => {
            incrementRestHttpClientThumbnailRateLimitRejected();
            await sendRateLimitResponse(request, response, optionsUsed);
          },
        });

  clientPasswordRecoveryRequestRateLimit =
    env.restClientPasswordRecoveryRateLimitMax === 0
      ? passthrough
      : rateLimit({
          windowMs: env.restClientPasswordRecoveryRateLimitWindowMs,
          limit: env.restClientPasswordRecoveryRateLimitMax,
          ...(optionalRedisStore("client_password_recovery_request") ?? {}),
          standardHeaders: true,
          legacyHeaders: false,
          message: {
            message: "Too many password recovery requests, please try again later.",
            code: "TOO_MANY_REQUESTS",
          },
          handler: async (request, response, _next, optionsUsed) => {
            incrementRestHttpClientPasswordRecoveryRequestRateLimitRejected();
            await sendRateLimitResponse(request, response, optionsUsed);
          },
        });

  agentsCommandsRateLimit = agentsCommandsUserRateLimit;
}
