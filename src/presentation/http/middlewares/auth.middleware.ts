import type { NextFunction, Request, Response } from "express";

import { forbidden, unauthorized } from "../../../shared/errors/http_errors";
import { verifyAccessToken, type JwtAccessPayload } from "../../../shared/utils/jwt";

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
