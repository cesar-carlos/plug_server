import type { NextFunction, Request, Response } from "express";

import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { negotiateApprovalHtmlLang } from "../helpers/approval_page_locale";
import {
  approvalHomeLabel,
  clientRegistrationDecisionCopy,
  clientRegistrationReviewCopy,
} from "../helpers/approval_registration_i18n";
import { renderApprovalReviewPage } from "../helpers/approval_pages";
import { renderApprovalDecisionHtml } from "../helpers/approval_decision_html";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientRegistrationApproveBody,
  ClientRegistrationRejectBody,
  ClientRegistrationRetryBody,
  ClientRegistrationTokenQuery,
  ClientRegisterBody,
} from "../validators/client_auth.validator";

const appHome = (
  lang: ReturnType<typeof negotiateApprovalHtmlLang>,
): { homeUrl: string; homeLabel: string } => {
  const homeUrl = env.appBaseUrl.replace(/\/+$/, "");
  return { homeUrl, homeLabel: approvalHomeLabel(lang) };
};

export const registerClient = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientRegisterBody>(response, "body");
  const result = await container.clientRegistrationService.register({
    ownerEmail: body.ownerEmail,
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
  if (result.value.duplicate) {
    response.status(202).json({ message: result.value.message });
    return;
  }
  response.status(201).json(result.value);
};

/** GET: read-only page with POST forms (no mutating GET). */
export const clientRegistrationReviewPage = async (
  request: Request,
  response: Response,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const copy = clientRegistrationReviewCopy(lang);
  const { token } = getValidated<ClientRegistrationTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const { homeUrl, homeLabel } = appHome(lang);
  const approveAction = `${base}/api/v1/client-auth/registration/approve`;
  const rejectAction = `${base}/api/v1/client-auth/registration/reject`;
  const summary = await container.clientRegistrationService.getRegistrationReviewSummary(token);

  let showActionForms = true;
  let readOnlyMessage: string | undefined;
  if (summary === null) {
    showActionForms = false;
    readOnlyMessage = copy.readOnlyInvalid;
  } else if (summary.tokenStatus === "expired") {
    showActionForms = false;
    readOnlyMessage = copy.readOnlyExpired;
  } else if (summary.clientStatus !== "pending") {
    showActionForms = false;
    readOnlyMessage = copy.readOnlyResolved(summary.clientStatus);
  }

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
    showActionForms,
    lang,
    textareaPlaceholder: copy.textareaPlaceholder,
    actionsAriaLabel: copy.actionsAriaLabel,
    homeUrl,
    homeLabel,
    ...(!showActionForms && readOnlyMessage !== undefined ? { readOnlyMessage } : {}),
    ...(summary === null
      ? {}
      : {
          summaryItems: [
            { label: copy.summaryOwnerEmail, value: summary.ownerEmail },
            { label: copy.summaryClient, value: summary.clientName },
            { label: copy.summaryClientEmail, value: summary.clientEmail },
            { label: copy.summaryAccountStatus, value: summary.clientStatus },
            { label: copy.summaryLinkStatus, value: summary.tokenStatus },
          ],
        }),
  });

  response.status(200).type("html").send(html);
};

export const clientRegistrationStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const { token } = getValidated<ClientRegistrationTokenQuery>(response, "query");
  const result = await container.clientRegistrationService.getRegistrationStatus(token);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json(result.value);
};

export const retryClientRegistration = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientRegistrationRetryBody>(response, "body");
  const result = await container.clientRegistrationService.retryClientRegistration({
    ownerEmail: body.ownerEmail,
    email: body.email,
    password: body.password,
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(202).json({
    message: "If eligible, a new approval request will be sent.",
  });
};

export const approveClientRegistration = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const decision = clientRegistrationDecisionCopy(lang);
  const body = getValidated<ClientRegistrationApproveBody>(response, "body");
  const result = await container.clientRegistrationService.approveRegistration(body.token);
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
        decision.approvedBody(result.value.clientEmail),
        "success",
      ),
    );
};

export const rejectClientRegistration = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const decision = clientRegistrationDecisionCopy(lang);
  const body = getValidated<ClientRegistrationRejectBody>(response, "body");
  const result = await container.clientRegistrationService.rejectRegistration(
    body.token,
    body.reason,
  );
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
        decision.rejectedBody(result.value.clientEmail),
        "danger",
      ),
    );
};
