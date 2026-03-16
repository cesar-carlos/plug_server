import type { NextFunction, Request, Response } from "express";

import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { getValidated } from "../middlewares/validate.middleware";
import type { LoginBody, LogoutBody, RefreshBody, RegisterBody } from "../validators/auth.validator";

const refreshTokenCookieName = "refresh_token";

const getRefreshTokenFromRequest = (
  request: Request,
  body: RefreshBody | LogoutBody,
): string | undefined => {
  const bodyToken = body.refreshToken;
  if (typeof bodyToken === "string" && bodyToken.trim() !== "") {
    return bodyToken;
  }

  const cookieToken = request.cookies?.[refreshTokenCookieName];
  if (typeof cookieToken === "string" && cookieToken.trim() !== "") {
    return cookieToken;
  }

  return undefined;
};

const setRefreshTokenCookie = (response: Response, token: string): void => {
  response.cookie(refreshTokenCookieName, token, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    path: "/api/v1/auth",
  });
};

const clearRefreshTokenCookie = (response: Response): void => {
  response.clearCookie(refreshTokenCookieName, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    path: "/api/v1/auth",
  });
};

export const register = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<RegisterBody>(response, "body");
  const result = await container.authService.register(body);
  if (!result.ok) { next(result.error); return; }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(201).json(result.value);
};

export const login = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<LoginBody>(response, "body");
  const result = await container.authService.login(body);
  if (!result.ok) { next(result.error); return; }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(200).json(result.value);
};

export const refresh = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<RefreshBody>(response, "body");
  const refreshToken = getRefreshTokenFromRequest(request, body);
  if (!refreshToken) {
    next(badRequest("Refresh token is required in body or cookie"));
    return;
  }

  const result = await container.authService.refresh(refreshToken);
  if (!result.ok) { next(result.error); return; }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(200).json(result.value);
};

export const logout = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<LogoutBody>(response, "body");
  const refreshToken = getRefreshTokenFromRequest(request, body);
  if (!refreshToken) {
    clearRefreshTokenCookie(response);
    response.status(204).send();
    return;
  }

  const result = await container.authService.logout(refreshToken);
  if (!result.ok) { next(result.error); return; }
  clearRefreshTokenCookie(response);
  response.status(204).send();
};

export const getMe = (
  _request: Request,
  response: Response,
): void => {
  const authUser = response.locals.authUser as JwtAccessPayload;
  response.status(200).json({ user: authUser });
};
