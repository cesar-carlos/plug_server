import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import type { NextFunction as ExpressNextFunction, RequestHandler } from "express";

import { badRequest } from "../../../shared/errors/http_errors";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";
import { getAuthClient } from "../middlewares/auth.middleware";
import { clearRefreshCookie } from "../helpers/refresh_cookie";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientChangePasswordBody,
  ClientPatchMeBody,
} from "../validators/client_auth.validator";

const refreshTokenCookieName = "client_refresh_token";

export const clientThumbnailUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.clientThumbnailMaxBytes,
    files: 1,
  },
});

const ALLOWED_THUMBNAIL_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const ALLOWED_THUMBNAIL_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"]);

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
  const result = await container.clientProfileService.updateMyProfile(
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
  clearRefreshCookie(response, refreshTokenCookieName);
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

  const sharpModule = (await import("sharp")).default;
  let detectedFormat: string | undefined;
  try {
    const metadata = await sharpModule(file.buffer).metadata();
    detectedFormat = metadata.format;
  } catch (error) {
    logger.warn("client_thumbnail_decode_failed", {
      clientSub: authClient.sub,
      message: error instanceof Error ? error.message : String(error),
    });
    next(badRequest("thumbnail file is not a valid image"));
    return;
  }
  if (!detectedFormat || !ALLOWED_THUMBNAIL_FORMATS.has(detectedFormat)) {
    next(badRequest("thumbnail file format is not supported"));
    return;
  }

  const result = await container.clientProfileService.updateThumbnail(
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
