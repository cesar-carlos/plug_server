import type { Request, Response } from "express";
import type { ClientAdministrativePermission } from "../../../domain/ports/client_delegation.port";
import { container } from "../../../shared/di/container";
import { getAuthClient } from "../middlewares/auth.middleware";
import { getValidated } from "../middlewares/validate.middleware";
import { buildHttpSuccessResponseBody } from "../helpers/http_success_response";
import { clientDelegationVerifyHeaders } from "../validators/client_delegation.validator";
type Input = {
  audience: string;
  personaId: string;
  administrative?: readonly ClientAdministrativePermission[];
};
export const createClientDelegation = async (_req: Request, res: Response): Promise<void> => {
  const input = getValidated<Input>(res, "body");
  const data = await container.clientDelegationService.create(getAuthClient(res).sub, input);
  res.setHeader("Cache-Control", "no-store");
  res
    .status(201)
    .json(
      buildHttpSuccessResponseBody({ data, requestId: res.locals.requestId as string | undefined }),
    );
};
export const verifyClientDelegation = async (req: Request, res: Response): Promise<void> => {
  const { authorization } = clientDelegationVerifyHeaders.parse(req.headers);
  const data = await container.clientDelegationService.verify(
    authorization.slice(7),
    getValidated<Input>(res, "body"),
  );
  res.setHeader("Cache-Control", "no-store");
  res.json(
    buildHttpSuccessResponseBody({ data, requestId: res.locals.requestId as string | undefined }),
  );
};
export const revokeClientDelegation = async (_req: Request, res: Response): Promise<void> => {
  await container.clientDelegationService.revoke(
    getAuthClient(res).sub,
    getValidated<{ id: string }>(res, "params").id,
  );
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
};
