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
  UserSetClientStatusBody,
} from "../validators/user_clients.validator";

export const listMyClients = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authUser = getAuthUser(response);
    const query = getValidated<UserListClientsQuery>(response, "query");
    const result = await container.clientAuthService.listManagedClientsPage(authUser.sub, {
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
  } catch (error) {
    next(error);
  }
};

export const getMyClient = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authUser = getAuthUser(response);
    const { clientId } = getValidated<UserClientIdParam>(response, "params");
    const result = await container.clientAuthService.findManagedClient(authUser.sub, clientId);
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(200).json({ client: result.value });
  } catch (error) {
    next(error);
  }
};

export const setMyClientStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authUser = getAuthUser(response);
    const { clientId } = getValidated<UserClientIdParam>(response, "params");
    const body = getValidated<UserSetClientStatusBody>(response, "body");
    const result = await container.clientAuthService.setManagedClientStatus(
      authUser.sub,
      clientId,
      body.status,
    );
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(200).json({ client: result.value });
  } catch (error) {
    next(error);
  }
};

export const listMyClientAccessRequests = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authUser = getAuthUser(response);
    const query = getValidated<UserListClientAccessRequestsQuery>(response, "query");
    const result = await container.clientAgentAccessService.listRequestsByOwnerPage(authUser.sub, {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
      ...(query.clientId !== undefined ? { clientId: query.clientId } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
    });
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(200).json({
      requests: result.value.items,
      count: result.value.items.length,
      total: result.value.total,
      page: result.value.page,
      pageSize: result.value.pageSize,
    });
  } catch (error) {
    next(error);
  }
};

export const approveMyClientAccessRequest = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authUser = getAuthUser(response);
    const { requestId } = getValidated<UserClientAccessRequestIdParam>(response, "params");
    const result = await container.clientAgentAccessService.approveByOwner(authUser.sub, requestId);
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(200).json({
      approved: true,
      agentId: result.value.agentId,
      clientEmail: result.value.clientEmail,
    });
  } catch (error) {
    next(error);
  }
};

export const rejectMyClientAccessRequest = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authUser = getAuthUser(response);
    const { requestId } = getValidated<UserClientAccessRequestIdParam>(response, "params");
    const body = getValidated<UserRejectClientAccessRequestBody>(response, "body");
    const result = await container.clientAgentAccessService.rejectByOwner(
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
  } catch (error) {
    next(error);
  }
};

export const listMyAgentClients = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authUser = getAuthUser(response);
    const { agentId } = getValidated<UserAgentIdParam>(response, "params");
    const query = getValidated<UserListAgentClientsQuery>(response, "query");
    const result = await container.clientAgentAccessService.listAgentClientsByOwnerPage(
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
  } catch (error) {
    next(error);
  }
};

export const revokeMyAgentClientAccess = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authUser = getAuthUser(response);
    const { agentId, clientId } = getValidated<UserAgentClientParam>(response, "params");
    const result = await container.clientAgentAccessService.revokeAccessByOwner(
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
  } catch (error) {
    next(error);
  }
};
