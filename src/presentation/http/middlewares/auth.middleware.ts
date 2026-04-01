import type { NextFunction, Request, RequestHandler, Response } from "express";

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
  const result = await container.authService.getActiveAccountUser(
    authUser.sub,
    response.locals.activeAccountUser,
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
  return container.authService.getActiveAccountUser(userId, response.locals.activeAccountUser);
};

/** `requireAuth` plus DB check that the account is not blocked. */
export const requireAuthAndActiveAccount: RequestHandler[] = [
  requireAuth,
  asyncHandler(requireActiveAccount),
];
