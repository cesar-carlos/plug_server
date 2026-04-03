import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Client } from "../../../domain/entities/client.entity";
import type { User } from "../../../domain/entities/user.entity";
import { container } from "../../../shared/di/container";
import { forbidden, unauthorized } from "../../../shared/errors/http_errors";
import type { Result } from "../../../shared/errors/result";
import { verifyAccessToken, type JwtAccessPayload } from "../../../shared/utils/jwt";
import { asyncHandler } from "./async_handler";

export const requireAuth = (request: Request, response: Response, next: NextFunction): void => {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    next(unauthorized("Bearer token required"));
    return;
  }

  const token = authorization.replace("Bearer ", "").trim();
  const result = verifyAccessToken(token);

  if (!result.ok) {
    next(result.error);
    return;
  }

  response.locals.authUser = result.value;
  next();
};

export const requireClientAuth = (request: Request, response: Response, next: NextFunction): void => {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    next(unauthorized("Bearer token required"));
    return;
  }

  const token = authorization.replace("Bearer ", "").trim();
  const result = verifyAccessToken(token);

  if (!result.ok) {
    next(result.error);
    return;
  }

  const payload = result.value;
  if (payload.principal_type !== "client") {
    next(forbidden("Client token required"));
    return;
  }

  response.locals.authClient = payload;
  next();
};

export const requireRole =
  (...roles: string[]) =>
  (_request: Request, response: Response, next: NextFunction): void => {
    const user = response.locals.authUser as JwtAccessPayload | undefined;
    const role = user?.role;
    if (!user || !role || !roles.includes(role)) {
      next(forbidden("Insufficient permissions"));
      return;
    }
    next();
  };

/** Returns the authenticated user from locals, throwing if not set (should not happen after requireAuth). */
export const getAuthUser = (response: Response): JwtAccessPayload => {
  const user = response.locals.authUser as JwtAccessPayload | undefined;
  if (!user) throw unauthorized("Authentication required");
  return user;
};

export const getAuthClient = (response: Response): JwtAccessPayload => {
  const client = response.locals.authClient as JwtAccessPayload | undefined;
  if (!client) throw unauthorized("Client authentication required");
  return client;
};

/**
 * After `requireAuth`: rejects requests when the user account is `blocked` (DB check).
 * Use together with {@link requireAuthAndActiveAccount} on protected HTTP routes.
 */
export const requireActiveAccount = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = response.locals.authUser as JwtAccessPayload | undefined;
  if (!authUser?.sub) {
    next(unauthorized("Authentication required"));
    return;
  }
  if (authUser.principal_type === "client") {
    next(forbidden("User token required"));
    return;
  }
  const result = await container.authService.getActiveAccountUser(
    authUser.sub,
    response.locals.activeAccountUser,
    authUser.credentials_version,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.locals.activeAccountUser = result.value;
  next();
};

/**
 * Reuses `response.locals.activeAccountUser` when `userId` matches (no extra `findById` on routes
 * that already ran {@link requireActiveAccount}).
 */
export const resolveActiveAccountUser = async (
  response: Response,
  userId: string,
): Promise<Result<User>> => {
  const authUser = response.locals.authUser as JwtAccessPayload | undefined;
  return container.authService.getActiveAccountUser(
    userId,
    response.locals.activeAccountUser,
    authUser?.credentials_version,
  );
};

/** `requireAuth` plus DB check that the account is not blocked. */
export const requireAuthAndActiveAccount: RequestHandler[] = [
  requireAuth,
  asyncHandler(requireActiveAccount),
];

const requirePrincipalActiveAccount = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authPrincipal = response.locals.authUser as JwtAccessPayload | undefined;
  if (!authPrincipal?.sub) {
    next(unauthorized("Authentication required"));
    return;
  }

  if (authPrincipal.principal_type === "client") {
    const result = await container.clientAuthService.getActiveClient(
      authPrincipal.sub,
      undefined,
      authPrincipal.credentials_version,
    );
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.locals.activeAccountClient = result.value;
    next();
    return;
  }

  const result = await container.authService.getActiveAccountUser(
    authPrincipal.sub,
    response.locals.activeAccountUser,
    authPrincipal.credentials_version,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.locals.activeAccountUser = result.value;
  next();
};

export const requirePrincipalAuthAndActiveAccount: RequestHandler[] = [
  requireAuth,
  asyncHandler(requirePrincipalActiveAccount),
];

export const requireClientActiveAccount = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = response.locals.authClient as JwtAccessPayload | undefined;
  if (!authClient?.sub) {
    next(unauthorized("Client authentication required"));
    return;
  }

  const result = await container.clientAuthService.getActiveClient(
    authClient.sub,
    undefined,
    authClient.credentials_version,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.locals.activeAccountClient = result.value;
  next();
};

export const resolveActiveAccountClient = async (
  response: Response,
  clientId: string,
): Promise<Result<Client>> => {
  const cached = response.locals.activeAccountClient as Client | undefined;
  if (cached && cached.id === clientId) {
    return { ok: true, value: cached };
  }
  return container.clientAuthService.getActiveClient(clientId);
};

export const requireClientAuthAndActiveAccount: RequestHandler[] = [
  requireClientAuth,
  asyncHandler(requireClientActiveAccount),
];
