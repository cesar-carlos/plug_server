import type { Request, Response } from "express";
import { container } from "../../../shared/di/container";
import { getAuthClient } from "../middlewares/auth.middleware";
import { getValidated } from "../middlewares/validate.middleware";
import { buildHttpSuccessResponseBody } from "../helpers/http_success_response";

export const issuePwaOfflineAuthorization = async (_req: Request, res: Response): Promise<void> => {
  const { agentIds } = getValidated<{ agentIds: string[] }>(res, "body");
  const data = await container.pwaOfflineAuthorizationService.issue(
    getAuthClient(res).sub,
    agentIds,
  );
  res.setHeader("Cache-Control", "no-store");
  res.json(
    buildHttpSuccessResponseBody({ data, requestId: res.locals.requestId as string | undefined }),
  );
};

export const getPwaPushKey = async (_req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(
    buildHttpSuccessResponseBody({
      data: container.pwaPushService.publicKey(),
      requestId: res.locals.requestId as string | undefined,
    }),
  );
};
export const putPwaSubscription = async (_req: Request, res: Response): Promise<void> => {
  const { installationId } = getValidated<{ installationId: string }>(res, "params");
  const { endpoint, keys } = getValidated<{
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }>(res, "body");
  await container.pwaPushService.subscribe({
    clientId: getAuthClient(res).sub,
    installationId,
    endpoint,
    ...keys,
  });
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
};
export const deletePwaSubscription = async (_req: Request, res: Response): Promise<void> => {
  const { installationId } = getValidated<{ installationId: string }>(res, "params");
  await container.pwaPushService.unsubscribe(getAuthClient(res).sub, installationId);
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
};
