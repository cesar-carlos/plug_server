import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import type { NextFunction as ExpressNextFunction, RequestHandler } from "express";

import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { getAuthClient } from "../middlewares/auth.middleware";
import { negotiateApprovalHtmlLang } from "../helpers/approval_page_locale";
import {
  approvalDecisionEyebrow,
  approvalHomeLabel,
  clientRegistrationDecisionCopy,
  clientRegistrationReviewCopy,
} from "../helpers/approval_registration_i18n";
import { renderApprovalDecisionPage, renderApprovalReviewPage } from "../helpers/approval_pages";
import { clearRefreshCookie, setRefreshCookie } from "../helpers/refresh_cookie";
import { escapeHtmlAttr } from "../helpers/html_escape";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientRegistrationApproveBody,
  ClientRegistrationRejectBody,
  ClientRegistrationRetryBody,
  ClientChangePasswordBody,
  ClientPatchMeBody,
  ClientPasswordRecoveryRequestBody,
  ClientPasswordRecoveryResetBody,
  ClientPasswordRecoveryTokenQuery,
  ClientRegistrationTokenQuery,
  ClientLoginBody,
  ClientLogoutBody,
  ClientRefreshBody,
  ClientRegisterBody,
} from "../validators/client_auth.validator";

const refreshTokenCookieName = "client_refresh_token";

/**
 * Memory-storage multer for the single-image thumbnail upload. Exposed so the
 * route file can mount it as middleware (declarative pipeline) instead of
 * invoking it imperatively from the controller.
 */
export const clientThumbnailUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.clientThumbnailMaxBytes,
    files: 1,
  },
});

/**
 * Allow-list of image MIME types accepted for client thumbnail uploads.
 * The `mimetype` field reported by multer is client-provided, so the controller
 * additionally validates that the buffer matches the declared format via
 * `sharp().metadata()` before persisting.
 */
const ALLOWED_THUMBNAIL_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const ALLOWED_THUMBNAIL_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"]);

/**
 * Wraps a multer middleware so file-validation errors (size limit, too many files,
 * unexpected field) become 400 `AppError`s with a stable code, instead of a raw
 * `MulterError` that the global error middleware would surface as a 500.
 */
export const wrapMulterErrors = (handler: RequestHandler): RequestHandler => {
  return (request, response, next) => {
    handler(request, response, (error: unknown) => {
      if (!error) {
        next();
        return;
      }
      if (error instanceof MulterError) {
        next(badRequest(`thumbnail upload rejected: ${error.code}`));
        return;
      }
      next(error as Parameters<ExpressNextFunction>[0]);
    });
  };
};

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
  setRefreshCookie(response, refreshTokenCookieName, token);
};

const clearRefreshTokenCookie = (response: Response): void => {
  clearRefreshCookie(response, refreshTokenCookieName);
};

const appHome = (
  lang: ReturnType<typeof negotiateApprovalHtmlLang>,
): { homeUrl: string; homeLabel: string } => {
  const homeUrl = env.appBaseUrl.replace(/\/+$/, "");
  return { homeUrl, homeLabel: approvalHomeLabel(lang) };
};

const registrationDecisionHtml = (
  lang: ReturnType<typeof negotiateApprovalHtmlLang>,
  title: string,
  bodyText: string,
  tone: "success" | "danger" | "neutral",
): string => {
  const { homeUrl, homeLabel } = appHome(lang);
  return renderApprovalDecisionPage({
    title,
    bodyText,
    tone,
    lang,
    decisionEyebrow: approvalDecisionEyebrow(lang),
    homeUrl,
    homeLabel,
  });
};

export const registerClient = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientRegisterBody>(response, "body");
  const result = await container.clientAuthService.register({
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
  const summary = await container.clientAuthService.getRegistrationReviewSummary(token);
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
  const result = await container.clientAuthService.getRegistrationStatus(token);
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
  const result = await container.clientAuthService.retryRejectedRegistration({
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
  const result = await container.clientAuthService.approveRegistration(body.token);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response
    .status(200)
    .type("html")
    .send(
      registrationDecisionHtml(
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
  const result = await container.clientAuthService.rejectRegistration(body.token, body.reason);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response
    .status(200)
    .type("html")
    .send(
      registrationDecisionHtml(
        lang,
        decision.rejectedTitle,
        decision.rejectedBody(result.value.clientEmail),
        "danger",
      ),
    );
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
  // Clear cookie up-front so the browser stops resending a stale token even
  // when the revoke call fails (e.g. token already revoked / unknown).
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

export const getClientMe = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const preloaded = response.locals.activeAccountClient;
  const result = await container.clientAuthService.getMeProfile(authClient.sub, preloaded);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ client: result.value });
};

export const patchClientMe = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const body = getValidated<ClientPatchMeBody>(response, "body");
  const result = await container.clientAuthService.updateMyProfile(
    authClient.sub,
    {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
      ...(body.mobile !== undefined ? { mobile: body.mobile } : {}),
      ...(body.thumbnailUrl !== undefined ? { thumbnailUrl: body.thumbnailUrl } : {}),
    },
    response.locals.activeAccountClient,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ client: result.value });
};

export const changeClientPassword = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const body = getValidated<ClientChangePasswordBody>(response, "body");
  const result = await container.clientAuthService.changePassword({
    clientId: authClient.sub,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  clearRefreshTokenCookie(response);
  response.status(204).send();
};

export const uploadClientThumbnail = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const file = request.file;
  if (!file) {
    next(badRequest("thumbnail file is required"));
    return;
  }
  const declaredType = file.mimetype.toLowerCase();
  if (!ALLOWED_THUMBNAIL_MIME_TYPES.has(declaredType)) {
    next(badRequest("thumbnail file must be PNG, JPEG, WebP or GIF"));
    return;
  }

  // Magic-bytes validation: trust the bytes, not the client-supplied header.
  const sharpModule = (await import("sharp")).default;
  let detectedFormat: string | undefined;
  try {
    const metadata = await sharpModule(file.buffer).metadata();
    detectedFormat = metadata.format;
  } catch (error) {
    next(
      badRequest(
        `thumbnail file is not a valid image (${
          error instanceof Error ? error.message : "decode_failed"
        })`,
      ),
    );
    return;
  }
  if (!detectedFormat || !ALLOWED_THUMBNAIL_FORMATS.has(detectedFormat)) {
    next(badRequest("thumbnail file format is not supported"));
    return;
  }

  const result = await container.clientAuthService.updateThumbnail(
    authClient.sub,
    {
      buffer: file.buffer,
      mimeType: declaredType,
    },
    response.locals.activeAccountClient,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ client: result.value });
};

export const clientPasswordRecoveryRequest = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientPasswordRecoveryRequestBody>(response, "body");
  const result = await container.clientAuthService.requestPasswordRecovery(body.email);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(202).json({
    message: "If the account exists, a password recovery email will be sent shortly.",
  });
};

/** GET: read-only page with POST form (no mutating GET). */
export const clientPasswordRecoveryReviewPage = (_request: Request, response: Response): void => {
  const { token } = getValidated<ClientPasswordRecoveryTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const resetAction = `${base}/api/v1/client-auth/password-recovery/reset`;
  const safeToken = escapeHtmlAttr(token);

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Reset client password</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;">
  <h1>Reset client password</h1>
  <p>Set a new password below. This page does not mutate data until you submit the POST form.</p>
  <form method="post" action="${resetAction}">
    <input type="hidden" name="token" value="${safeToken}"/>
    <label for="newPassword">New password</label><br/>
    <input id="newPassword" name="newPassword" type="password" minlength="8" maxlength="128" required style="margin:0.5rem 0;"/><br/>
    <button type="submit" style="padding:10px 16px;background:#0d6efd;color:#fff;border:none;border-radius:6px;cursor:pointer;">Reset password</button>
  </form>
</body>
</html>`;
  response.status(200).type("html").send(html);
};

export const clientPasswordRecoveryStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const { token } = getValidated<ClientPasswordRecoveryTokenQuery>(response, "query");
  const result = await container.clientAuthService.getPasswordRecoveryStatus(token);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json(result.value);
};

export const clientPasswordRecoveryReset = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientPasswordRecoveryResetBody>(response, "body");
  const result = await container.clientAuthService.resetPasswordByRecoveryToken(
    body.token,
    body.newPassword,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  clearRefreshTokenCookie(response);
  response.status(204).send();
};
