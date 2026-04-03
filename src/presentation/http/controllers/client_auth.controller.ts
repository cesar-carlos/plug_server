import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { getAuthClient } from "../middlewares/auth.middleware";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientRegistrationApproveBody,
  ClientRegistrationRejectBody,
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
const clientThumbnailUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.clientThumbnailMaxBytes,
    files: 1,
  },
});

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
export const clientRegistrationReviewPage = (_request: Request, response: Response): void => {
  const { token } = getValidated<ClientRegistrationTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const approveAction = `${base}/api/v1/client-auth/registration/approve`;
  const rejectAction = `${base}/api/v1/client-auth/registration/reject`;
  const safeToken = escapeHtmlAttr(token);

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Review client registration</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;">
  <h1>Review client registration</h1>
  <p>Submitting a form below will approve or reject client registration. GET requests do not change data.</p>
  <form method="post" action="${approveAction}" style="margin-bottom:1.5rem;">
    <input type="hidden" name="token" value="${safeToken}"/>
    <button type="submit" style="padding:10px 16px;background:#0d6efd;color:#fff;border:none;border-radius:6px;cursor:pointer;">Approve registration</button>
  </form>
  <form method="post" action="${rejectAction}">
    <input type="hidden" name="token" value="${safeToken}"/>
    <label for="reason">Optional note to the client (max 500 characters)</label><br/>
    <textarea id="reason" name="reason" rows="3" cols="50" maxlength="500" style="margin:0.5rem 0;"></textarea><br/>
    <button type="submit" style="padding:10px 16px;background:#dc3545;color:#fff;border:none;border-radius:6px;cursor:pointer;">Reject registration</button>
  </form>
</body>
</html>`;

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

export const approveClientRegistration = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
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
        "Client registration approved",
        `The client account ${result.value.clientEmail} can now sign in.`,
      ),
    );
};

export const rejectClientRegistration = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
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
        "Client registration rejected",
        `The registration for ${result.value.clientEmail} was not approved.`,
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
  const parseResult = await new Promise<Error | null>((resolve) => {
    clientThumbnailUpload.single("thumbnail")(request, response, (error) => {
      resolve(error ?? null);
    });
  });
  if (parseResult) {
    next(badRequest(parseResult.message));
    return;
  }

  const authClient = getAuthClient(response);
  const file = request.file;
  if (!file) {
    next(badRequest("thumbnail file is required"));
    return;
  }
  if (!file.mimetype.startsWith("image/")) {
    next(badRequest("thumbnail file must be an image"));
    return;
  }

  const result = await container.clientAuthService.updateThumbnail(
    authClient.sub,
    {
      buffer: file.buffer,
      mimeType: file.mimetype,
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
