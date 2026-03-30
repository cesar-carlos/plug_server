import type { NextFunction, Request, Response } from "express";

import type { AuthResponseDto, AuthTokensDto } from "../../../application/dtos/auth.dto";
import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  AgentLoginBody,
  ChangePasswordBody,
  LoginBody,
  LogoutBody,
  RefreshBody,
  RegisterBody,
  RegistrationApproveBody,
  RegistrationRejectBody,
  RegistrationTokenQuery,
} from "../validators/auth.validator";

const refreshTokenCookieName = "refresh_token";

type CompatibleAuthPayload<T extends AuthTokensDto> = T & {
  readonly success: true;
  readonly token: string;
};

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

const toCompatibleAuthPayload = <T extends AuthTokensDto>(payload: T): CompatibleAuthPayload<T> => {
  return {
    ...payload,
    success: true,
    token: payload.accessToken,
  };
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeHtmlAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const registrationDecisionHtml = (title: string, bodyText: string): string => {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(bodyText);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>${safeTitle}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;">
  <h1>${safeTitle}</h1>
  <p>${safeBody}</p>
</body>
</html>`;
};

export const register = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<RegisterBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.authService.register(body, {
    ...(requestId !== undefined ? { requestId } : {}),
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(201).json(result.value);
};

/** GET: read-only page with POST forms (no mutating GET). */
export const registrationReviewPage = (_request: Request, response: Response): void => {
  const { token } = getValidated<RegistrationTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const approveAction = `${base}/api/v1/auth/registration/approve`;
  const rejectAction = `${base}/api/v1/auth/registration/reject`;
  const safeToken = escapeHtmlAttr(token);

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Review registration</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;">
  <h1>Review registration</h1>
  <p>Submitting a form below will approve or reject the account. GET requests do not change data.</p>
  <form method="post" action="${approveAction}" style="margin-bottom:1.5rem;">
    <input type="hidden" name="token" value="${safeToken}"/>
    <button type="submit" style="padding:10px 16px;background:#0d6efd;color:#fff;border:none;border-radius:6px;cursor:pointer;">Approve registration</button>
  </form>
  <form method="post" action="${rejectAction}">
    <input type="hidden" name="token" value="${safeToken}"/>
    <label for="reason">Optional note to the user (max 500 characters)</label><br/>
    <textarea id="reason" name="reason" rows="3" cols="50" maxlength="500" style="margin:0.5rem 0;"></textarea><br/>
    <button type="submit" style="padding:10px 16px;background:#dc3545;color:#fff;border:none;border-radius:6px;cursor:pointer;">Reject registration</button>
  </form>
</body>
</html>`;

  response.status(200).type("html").send(html);
};

export const registrationStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const { token } = getValidated<RegistrationTokenQuery>(response, "query");
  const result = await container.authService.getRegistrationStatus(token);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json(result.value);
};

export const approveRegistration = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<RegistrationApproveBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.authService.approveRegistration(body.token, {
    ...(requestId !== undefined ? { requestId } : {}),
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  response
    .status(200)
    .type("html")
    .send(
      registrationDecisionHtml(
        "Registration approved",
        `The account ${result.value.email} can now sign in.`,
      ),
    );
};

export const rejectRegistration = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<RegistrationRejectBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.authService.rejectRegistration(body.token, body.reason, {
    ...(requestId !== undefined ? { requestId } : {}),
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  response
    .status(200)
    .type("html")
    .send(
      registrationDecisionHtml(
        "Registration rejected",
        `The registration for ${result.value.email} was not approved.`,
      ),
    );
};

export const login = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<LoginBody>(response, "body");
  const result = await container.authService.login({
    email: body.email,
    password: body.password,
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(200).json(toCompatibleAuthPayload<AuthResponseDto>(result.value));
};

export const agentLogin = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<AgentLoginBody>(response, "body");
  const result = await container.authService.agentLogin({
    email: body.email,
    password: body.password,
    agentId: body.agentId,
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(200).json({
    ...toCompatibleAuthPayload(result.value),
    user: result.value.user,
  });
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
  if (!result.ok) {
    next(result.error);
    return;
  }
  setRefreshTokenCookie(response, result.value.refreshToken);
  response.status(200).json(toCompatibleAuthPayload(result.value));
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
  if (!result.ok) {
    next(result.error);
    return;
  }
  clearRefreshTokenCookie(response);
  response.status(204).send();
};

export const getMe = (_request: Request, response: Response): void => {
  const authUser = response.locals.authUser as JwtAccessPayload;
  response.status(200).json({ user: authUser });
};

export const changePassword = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = response.locals.authUser as JwtAccessPayload;
  const body = getValidated<ChangePasswordBody>(response, "body");

  const result = await container.authService.changePassword({
    userId: authUser.sub,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });

  if (!result.ok) {
    next(result.error);
    return;
  }

  response.status(204).send();
};
