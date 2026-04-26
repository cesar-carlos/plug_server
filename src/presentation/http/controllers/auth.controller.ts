import type { NextFunction, Request, Response } from "express";

import type { AuthResponseDto, AuthTokensDto } from "../../../application/dtos/auth.dto";
import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import type { User } from "../../../domain/entities/user.entity";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { renderApprovalDecisionPage, renderApprovalReviewPage } from "../helpers/approval_pages";
import { clearRefreshCookie, setRefreshCookie } from "../helpers/refresh_cookie";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  AgentLoginBody,
  ChangePasswordBody,
  LoginBody,
  LogoutBody,
  PatchMeBody,
  RefreshBody,
  RegisterBody,
  RegistrationApproveBody,
  RegistrationRejectBody,
  RegistrationRetryBody,
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
  setRefreshCookie(response, refreshTokenCookieName, token);
};

const clearRefreshTokenCookie = (response: Response): void => {
  clearRefreshCookie(response, refreshTokenCookieName);
};

const toCompatibleAuthPayload = <T extends AuthTokensDto>(payload: T): CompatibleAuthPayload<T> => {
  return {
    ...payload,
    success: true,
    token: payload.accessToken,
  };
};

const registrationDecisionHtml = (
  title: string,
  bodyText: string,
  tone: "success" | "danger" | "neutral",
): string => renderApprovalDecisionPage({ title, bodyText, tone });

export const register = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<RegisterBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.authService.register(
    {
      email: body.email,
      password: body.password,
      ...(body.celular !== undefined ? { celular: body.celular } : {}),
    },
    {
      ...(requestId !== undefined ? { requestId } : {}),
    },
  );
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
  const html = renderApprovalReviewPage({
    title: "Review registration",
    eyebrow: "User approval",
    description:
      "Approve the account only if this registration is expected. GET requests do not change data.",
    approveAction,
    rejectAction,
    token,
    approveLabel: "Approve registration",
    rejectLabel: "Reject registration",
    reasonLabel: "Optional note to the user (max 500 characters)",
  });

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

export const retryRegistration = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<RegistrationRetryBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.authService.retryRejectedRegistration(
    {
      email: body.email,
      password: body.password,
    },
    {
      ...(requestId !== undefined ? { requestId } : {}),
    },
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(202).json({
    message: "If eligible, a new approval request will be sent.",
  });
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
        "success",
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
        "danger",
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
  // `toCompatibleAuthPayload` already spreads the full `result.value`
  // (including `user`); avoid duplicating the field in the response body.
  response.status(200).json(toCompatibleAuthPayload(result.value));
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
  // Always clear the cookie up-front so the browser stops resending a stale
  // token even when revocation fails (e.g. token already revoked / unknown).
  clearRefreshTokenCookie(response);
  if (!refreshToken) {
    response.status(204).send();
    return;
  }

  const result = await container.authService.logout(refreshToken);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(204).send();
};

export const getMe = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = response.locals.authUser as JwtAccessPayload;
  const preloaded = response.locals.activeAccountUser as User | undefined;
  const result = await container.authService.getMeProfile(authUser, preloaded);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ user: result.value });
};

export const patchMe = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = response.locals.authUser as JwtAccessPayload;
  const body = getValidated<PatchMeBody>(response, "body");
  const result = await container.authService.updateMyCelular(authUser, { celular: body.celular });
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ user: result.value });
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

  // Sessions (including refresh tokens) are invalidated server-side; clear the
  // browser cookie so the client does not loop on a stale refresh token.
  clearRefreshTokenCookie(response);
  response.status(204).send();
};
