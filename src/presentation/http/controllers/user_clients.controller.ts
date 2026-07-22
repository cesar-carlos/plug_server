import type { NextFunction, Request, Response } from "express";

import { container } from "../../../shared/di/container";
import { getAuthUser } from "../middlewares/auth.middleware";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  UserAgentIdParam,
  UserAgentClientParam,
  UserClientAccessRequestIdParam,
  UserClientIdParam,
  UserListAgentClientsQuery,
  UserListClientAccessRequestsQuery,
  UserListClientsQuery,
  UserRejectClientAccessRequestBody,
  UserRejectClientRegistrationBody,
  UserSetClientStatusBody,
} from "../validators/user_clients.validator";

export const listMyClients = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const query = getValidated<UserListClientsQuery>(response, "query");
  const result = await container.clientManagementService.listManagedClientsPage(authUser.sub, {
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.search !== undefined ? { search: query.search } : {}),
    ...(query.page !== undefined ? { page: query.page } : {}),
    ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    clients: result.value.items,
    count: result.value.items.length,
    total: result.value.total,
    page: result.value.page,
    pageSize: result.value.pageSize,
  });
};

export const getMyClient = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { clientId } = getValidated<UserClientIdParam>(response, "params");
  const result = await container.clientManagementService.findManagedClient(authUser.sub, clientId);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ client: result.value });
};

export const approveMyClientRegistration = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { clientId } = getValidated<UserClientIdParam>(response, "params");
  const result = await container.clientRegistrationService.approveByOwner(authUser.sub, clientId);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    approved: true,
    clientEmail: result.value.clientEmail,
  });
};

export const rejectMyClientRegistration = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { clientId } = getValidated<UserClientIdParam>(response, "params");
  const body = getValidated<UserRejectClientRegistrationBody>(response, "body");
  const result = await container.clientRegistrationService.rejectByOwner(
    authUser.sub,
    clientId,
    body.reason,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    rejected: true,
    clientEmail: result.value.clientEmail,
  });
};

export const setMyClientStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { clientId } = getValidated<UserClientIdParam>(response, "params");
  const body = getValidated<UserSetClientStatusBody>(response, "body");
  const result = await container.clientManagementService.setManagedClientStatus(
    authUser.sub,
    clientId,
    body.status,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ client: result.value });
};

export const listMyClientAccessRequests = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const query = getValidated<UserListClientAccessRequestsQuery>(response, "query");
  const result = await container.clientAgentAccessDecisionService.listRequestsByOwnerPage(
    authUser.sub,
    {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
      ...(query.clientId !== undefined ? { clientId: query.clientId } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
    },
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    requests: result.value.items.map(toOwnerClientAgentAccessRequestDto),
    count: result.value.items.length,
    total: result.value.total,
    page: result.value.page,
    pageSize: result.value.pageSize,
  });
};

export const approveMyClientAccessRequest = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { requestId } = getValidated<UserClientAccessRequestIdParam>(response, "params");
  const result = await container.clientAgentAccessDecisionService.approveByOwner(
    authUser.sub,
    requestId,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    approved: true,
    agentId: result.value.agentId,
    clientEmail: result.value.clientEmail,
  });
};

export const rejectMyClientAccessRequest = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { requestId } = getValidated<UserClientAccessRequestIdParam>(response, "params");
  const body = getValidated<UserRejectClientAccessRequestBody>(response, "body");
  const result = await container.clientAgentAccessDecisionService.rejectByOwner(
    authUser.sub,
    requestId,
    body.reason,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    rejected: true,
    agentId: result.value.agentId,
    clientEmail: result.value.clientEmail,
  });
};

export const listMyAgentClients = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { agentId } = getValidated<UserAgentIdParam>(response, "params");
  const query = getValidated<UserListAgentClientsQuery>(response, "query");
  const result = await container.clientAgentAccessDecisionService.listAgentClientsByOwnerPage(
    authUser.sub,
    agentId,
    {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
    },
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    clients: result.value.items.map((item) => ({
      ...item,
      approvedAt: item.approvedAt.toISOString(),
    })),
    count: result.value.items.length,
    total: result.value.total,
    page: result.value.page,
    pageSize: result.value.pageSize,
  });
};

export const revokeMyAgentClientAccess = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { agentId, clientId } = getValidated<UserAgentClientParam>(response, "params");
  const result = await container.clientAgentAccessDecisionService.revokeAccessByOwner(
    authUser.sub,
    agentId,
    clientId,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    revoked: true,
    agentId,
    clientId,
  });
};

const toOwnerClientAgentAccessRequestDto = (request: {
  id: string;
  clientId: string;
  agentId: string;
  agentName?: string;
  clientEmail?: string;
  clientName?: string;
  status: "pending" | "approved" | "rejected" | "expired" | "revoked";
  retryCount: number;
  requestedAt: Date;
  decidedAt?: Date;
  decisionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}): {
  id: string;
  clientId: string;
  agentId: string;
  agentName: string | null;
  clientEmail: string | null;
  clientName: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "revoked";
  retryCount: number;
  requestedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
} => ({
  id: request.id,
  clientId: request.clientId,
  agentId: request.agentId,
  agentName: request.agentName ?? null,
  clientEmail: request.clientEmail ?? null,
  clientName: request.clientName ?? null,
  status: request.status,
  retryCount: request.retryCount,
  requestedAt: request.requestedAt.toISOString(),
  decidedAt: request.decidedAt?.toISOString() ?? null,
  decisionReason: request.decisionReason ?? null,
  createdAt: request.createdAt.toISOString(),
  updatedAt: request.updatedAt.toISOString(),
});
