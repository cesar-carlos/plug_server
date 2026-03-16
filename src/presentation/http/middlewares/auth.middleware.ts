import type { NextFunction, Request, Response } from "express";

import { unauthorized } from "../../../shared/errors/http_errors";
import { verifyAccessToken } from "../../../shared/utils/jwt";

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
