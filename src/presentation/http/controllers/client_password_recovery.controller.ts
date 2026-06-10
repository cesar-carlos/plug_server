import type { NextFunction, Request, Response } from "express";

import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { renderApprovalDecisionHtml } from "../helpers/approval_decision_html";
import { isBrowserLikeApprovalErrorRequest } from "../helpers/approval_error_html";
import { negotiateApprovalHtmlLang } from "../helpers/approval_page_locale";
import {
  approvalHomeLabel,
  clientPasswordResetDecisionCopy,
  clientPasswordResetReviewCopy,
} from "../helpers/approval_registration_i18n";
import { renderPasswordResetFormPage } from "../helpers/approval_pages";
import { clearRefreshCookie } from "../helpers/refresh_cookie";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientPasswordRecoveryRequestBody,
  ClientPasswordRecoveryResetBody,
  ClientPasswordRecoveryTokenQuery,
} from "../validators/client_auth.validator";

const refreshTokenCookieName = "client_refresh_token";

const PASSWORD_RECOVERY_REQUEST_MESSAGE =
  "If the account exists, a password recovery email will be sent shortly.";

const appHome = (
  lang: ReturnType<typeof negotiateApprovalHtmlLang>,
): { homeUrl: string; homeLabel: string } => {
  const homeUrl = env.appBaseUrl.replace(/\/+$/, "");
  return { homeUrl, homeLabel: approvalHomeLabel(lang) };
};

export const clientPasswordRecoveryRequest = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientPasswordRecoveryRequestBody>(response, "body");
  const result = await container.clientPasswordRecoveryService.requestPasswordRecovery(body.email);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(202).json({
    success: true,
    data: { message: PASSWORD_RECOVERY_REQUEST_MESSAGE },
    message: PASSWORD_RECOVERY_REQUEST_MESSAGE,
  });
};

/** GET: read-only page with POST form (no mutating GET). */
export const clientPasswordRecoveryReviewPage = async (
  request: Request,
  response: Response,
  _next: NextFunction,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const copy = clientPasswordResetReviewCopy(lang);
  const { token } = getValidated<ClientPasswordRecoveryTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const resetAction = `${base}/api/v1/client-auth/password-recovery/reset`;
  const { homeUrl, homeLabel } = appHome(lang);

  const statusResult = await container.clientPasswordRecoveryService.getPasswordRecoveryStatus(
    token,
  );

  let showActionForms = true;
  let readOnlyMessage: string | undefined;
  if (!statusResult.ok || statusResult.value.status === "unknown") {
    showActionForms = false;
    readOnlyMessage = copy.readOnlyInvalid;
  } else if (statusResult.ok && statusResult.value.status === "expired") {
    showActionForms = false;
    readOnlyMessage = copy.readOnlyExpired;
  }

  const html = renderPasswordResetFormPage({
    title: copy.title,
    heading: copy.heading,
    description: copy.description,
    formAction: resetAction,
    token,
    passwordLabel: copy.passwordLabel,
    submitLabel: copy.submitLabel,
    showActionForms,
    lang,
    homeUrl,
    homeLabel,
    ...(!showActionForms && readOnlyMessage !== undefined ? { readOnlyMessage } : {}),
  });
  response.status(200).type("html").send(html);
};

export const clientPasswordRecoveryStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const { token } = getValidated<ClientPasswordRecoveryTokenQuery>(response, "query");
  const result = await container.clientPasswordRecoveryService.getPasswordRecoveryStatus(token);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json(result.value);
};

export const clientPasswordRecoveryReset = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientPasswordRecoveryResetBody>(response, "body");
  const result = await container.clientPasswordRecoveryService.resetPasswordByRecoveryToken(
    body.token,
    body.newPassword,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  clearRefreshCookie(response, refreshTokenCookieName);

  if (isBrowserLikeApprovalErrorRequest(request)) {
    const lang = negotiateApprovalHtmlLang(request);
    const copy = clientPasswordResetDecisionCopy(lang);
    response
      .status(200)
      .type("html")
      .send(renderApprovalDecisionHtml(lang, copy.successTitle, copy.successBody, "success"));
    return;
  }

  response.status(204).send();
};
