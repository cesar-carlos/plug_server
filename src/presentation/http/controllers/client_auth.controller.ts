import type { NextFunction, Request, Response } from "express";

import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { getAuthClient, getAuthUser } from "../middlewares/auth.middleware";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientLoginBody,
  ClientLogoutBody,
  ClientRefreshBody,
  ClientRegisterBody,
} from "../validators/client_auth.validator";

const refreshTokenCookieName = "client_refresh_token";

const getRefreshTokenFromRequest = (
  request: Request,
  body: ClientRefreshBody | ClientLogoutBody,
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
    path: "/",
  });
};

const clearRefreshTokenCookie = (response: Response): void => {
  response.clearCookie(refreshTokenCookieName, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    path: "/",
  });
};

export const registerClient = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientRegisterBody>(response, "body");
  const authUser = getAuthUser(response);
  const result = await container.clientAuthService.register({
    userId: authUser.sub,
    email: body.email,
    password: body.password,
    name: body.name,
    lastName: body.lastName,
    ...(body.mobile !== undefined ? { mobile: body.mobile } : {}),
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(201).json({
    ...result.value,
    success: true,
    token: result.value.accessToken,
  });
};

export const loginClient = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientLoginBody>(response, "body");
  const result = await container.clientAuthService.login({
    email: body.email,
    password: body.password,
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(200).json({
    ...result.value,
    success: true,
    token: result.value.accessToken,
  });
};

export const refreshClient = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientRefreshBody>(response, "body");
  const refreshToken = getRefreshTokenFromRequest(request, body);
  if (!refreshToken) {
    next(badRequest("Refresh token is required in body or cookie"));
    return;
  }

  const result = await container.clientAuthService.refresh(refreshToken);
  if (!result.ok) {
    next(result.error);
    return;
  }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(200).json({
    ...result.value,
    success: true,
    token: result.value.accessToken,
  });
};

export const logoutClient = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientLogoutBody>(response, "body");
  const refreshToken = getRefreshTokenFromRequest(request, body);
  if (!refreshToken) {
    clearRefreshTokenCookie(response);
    response.status(204).send();
    return;
  }

  const result = await container.clientAuthService.logout(refreshToken);
  if (!result.ok) {
    next(result.error);
    return;
  }
  clearRefreshTokenCookie(response);
  response.status(204).send();
};

export const getClientMe = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const result = await container.clientAuthService.getMeProfile(authClient.sub);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ client: result.value });
};
