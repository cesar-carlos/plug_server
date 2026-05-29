import type { NextFunction, Request, Response } from "express";

import type { AuthResponseDto, AuthTokensDto } from "../../../application/dtos/auth.dto";
import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import type { User } from "../../../domain/entities/user.entity";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { negotiateApprovalHtmlLang } from "../helpers/approval_page_locale";
import {
  approvalHomeLabel,
  userRegistrationDecisionCopy,
  userRegistrationReviewCopy,
} from "../helpers/approval_registration_i18n";
import { renderApprovalReviewPage } from "../helpers/approval_pages";
import { renderApprovalDecisionHtml } from "../helpers/approval_decision_html";
import {
  clearRefreshCookie,
  getRefreshTokenFromRequest as getRefreshTokenFromRequestShared,
  setRefreshCookie,
} from "../helpers/refresh_cookie";
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
): string | undefined => getRefreshTokenFromRequestShared(request, body, refreshTokenCookieName);

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

const appHome = (
  lang: ReturnType<typeof negotiateApprovalHtmlLang>,
): { homeUrl: string; homeLabel: string } => {
  const homeUrl = env.appBaseUrl.replace(/\/+$/, "");
  return { homeUrl, homeLabel: approvalHomeLabel(lang) };
};

export const register = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<RegisterBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.userRegistrationService.register(
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
export const registrationReviewPage = async (
  request: Request,
  response: Response,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const copy = userRegistrationReviewCopy(lang);
  const { token } = getValidated<RegistrationTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const { homeUrl, homeLabel } = appHome(lang);
  const approveAction = `${base}/api/v1/auth/registration/approve`;
  const rejectAction = `${base}/api/v1/auth/registration/reject`;
  const summary = await container.userRegistrationService.getRegistrationReviewSummary(token);
  const html = renderApprovalReviewPage({
    title: copy.title,
    eyebrow: copy.eyebrow,
    description: copy.description,
    approveAction,
    rejectAction,
    token,
    approveLabel: copy.approveLabel,
    rejectLabel: copy.rejectLabel,
    reasonLabel: copy.reasonLabel,
    lang,
    textareaPlaceholder: copy.textareaPlaceholder,
    actionsAriaLabel: copy.actionsAriaLabel,
    homeUrl,
    homeLabel,
    ...(summary === null
      ? {}
      : {
          summaryItems: [
            { label: copy.summaryUserEmail, value: summary.email },
            { label: copy.summaryAccountStatus, value: summary.status },
            { label: copy.summaryLinkStatus, value: summary.tokenStatus },
          ],
        }),
  });

  response.status(200).type("html").send(html);
};

export const registrationStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const { token } = getValidated<RegistrationTokenQuery>(response, "query");
  const result = await container.userRegistrationService.getRegistrationStatus(token);
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
  const result = await container.userRegistrationService.retryRejectedRegistration(
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
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const decision = userRegistrationDecisionCopy(lang);
  const body = getValidated<RegistrationApproveBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.userRegistrationService.approveRegistration(body.token, {
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
      renderApprovalDecisionHtml(
        lang,
        decision.approvedTitle,
        decision.approvedBody(result.value.email),
        "success",
      ),
    );
};

export const rejectRegistration = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const decision = userRegistrationDecisionCopy(lang);
  const body = getValidated<RegistrationRejectBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.userRegistrationService.rejectRegistration(body.token, body.reason, {
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
      renderApprovalDecisionHtml(
        lang,
        decision.rejectedTitle,
        decision.rejectedBody(result.value.email),
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
  const result = await container.userAccountService.updateMyCelular(authUser, { celular: body.celular });
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
