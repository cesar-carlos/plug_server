import type { NextFunction, Request, Response } from "express";

import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import {
  clearRefreshCookie,
  getRefreshTokenFromRequest as getRefreshTokenFromRequestShared,
  setRefreshCookie,
} from "../helpers/refresh_cookie";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientLoginBody,
  ClientLogoutBody,
  ClientRefreshBody,
} from "../validators/client_auth.validator";

const refreshTokenCookieName = "client_refresh_token";

const getRefreshTokenFromRequest = (
  request: Request,
  body: ClientRefreshBody | ClientLogoutBody,
): string | undefined => getRefreshTokenFromRequestShared(request, body, refreshTokenCookieName);

const setRefreshTokenCookie = (response: Response, token: string): void => {
  setRefreshCookie(response, refreshTokenCookieName, token);
};

const clearRefreshTokenCookie = (response: Response): void => {
  clearRefreshCookie(response, refreshTokenCookieName);
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
  clearRefreshTokenCookie(response);
  if (!refreshToken) {
    response.status(204).send();
    return;
  }

  const result = await container.clientAuthService.logout(refreshToken);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(204).send();
};
