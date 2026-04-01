import type { NextFunction, Request, Response } from "express";

import { container } from "../../../shared/di/container";
import { logger } from "../../../shared/utils/logger";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { getValidated } from "../middlewares/validate.middleware";
import type { AdminSetUserStatusBody, AdminUserIdParam } from "../validators/admin_users.validator";

export const patchUserStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const { id } = getValidated<AdminUserIdParam>(response, "params");
  const body = getValidated<AdminSetUserStatusBody>(response, "body");
  const authUser = response.locals.authUser as JwtAccessPayload;

  const result = await container.authService.adminSetUserStatus({
    targetUserId: id,
    status: body.status,
  });

  if (!result.ok) {
    next(result.error);
    return;
  }

  logger.info("admin_user_status_set", {
    requestId: response.locals.requestId as string | undefined,
    actorUserId: authUser.sub,
    targetUserId: id,
    status: body.status,
  });

  response.status(200).json({
    user: {
      id: result.value.id,
      email: result.value.email,
      status: result.value.status,
      role: result.value.role,
    },
  });
};
