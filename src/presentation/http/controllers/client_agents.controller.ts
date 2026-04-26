import type { NextFunction, Request, Response } from "express";

import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { getAuthClient } from "../middlewares/auth.middleware";
import { renderApprovalDecisionPage, renderApprovalReviewPage } from "../helpers/approval_pages";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientAccessApproveBody,
  ClientAgentAccessRequestIdParam,
  ClientAgentIdParam,
  ClientAccessRejectBody,
  ClientAccessReviewTokenQuery,
  ClientAgentIdsBody,
  ClientAgentTokenBody,
  ClientListAgentAccessRequestsQuery,
  ClientListAgentsQuery,
} from "../validators/client_agents.validator";
import {
  recordClientMeAgentsDetailResponse,
  recordClientMeAgentsListResponse,
} from "../../../shared/metrics/client_me_agents.metrics";
import { toClientAgentDto } from "../mappers/client_agent.mapper";

const decisionHtml = (
  title: string,
  bodyText: string,
  tone: "success" | "danger" | "neutral",
): string => renderApprovalDecisionPage({ title, bodyText, tone });

export const listMyClientAgents = async (
  _request: Request,
  response: Response,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const query = getValidated<ClientListAgentsQuery>(response, "query");
  const pageResult = await container.clientAgentAccessService.listApprovedAgentsPage(
    authClient.sub,
    {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
    },
    {
      refreshOnline: query.refresh === true,
    },
  );
  const tokenPresenceByAgent =
    await container.clientAgentAccessService.getClientTokenPresenceForAgents(
      authClient.sub,
      pageResult.items.map((agent) => agent.agentId),
    );
  const agents = pageResult.items.map((agent) =>
    toClientAgentDto(
      agent,
      container.isAgentConnectedToHub(agent.agentId),
      tokenPresenceByAgent.get(agent.agentId) === true,
    ),
  );
  recordClientMeAgentsListResponse(agents.filter((a) => a.isHubConnected).length);
  response.status(200).json({
    agents,
    agentIds: pageResult.items.map((agent) => agent.agentId),
    count: pageResult.items.length,
    total: pageResult.total,
    page: pageResult.page,
    pageSize: pageResult.pageSize,
  });
};

export const getMyClientAgent = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const { agentId } = getValidated<ClientAgentIdParam>(response, "params");
  const result = await container.clientAgentAccessService.findApprovedAgent(
    authClient.sub,
    agentId,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  const isHubConnected = container.isAgentConnectedToHub(agentId);
  const hasClientToken = await container.clientAgentAccessService.hasClientTokenForAgent(
    authClient.sub,
    agentId,
  );
  recordClientMeAgentsDetailResponse(isHubConnected);
  response.status(200).json({
    agent: toClientAgentDto(result.value, isHubConnected, hasClientToken),
  });
};

export const getMyClientAgentToken = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const { agentId } = getValidated<ClientAgentIdParam>(response, "params");
  const result = await container.clientAgentAccessService.getClientTokenForAgent(
    authClient.sub,
    agentId,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    agentId,
    clientToken: result.value.clientToken,
  });
};

export const setMyClientAgentToken = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const { agentId } = getValidated<ClientAgentIdParam>(response, "params");
  const body = getValidated<ClientAgentTokenBody>(response, "body");
  const result = await container.clientAgentAccessService.setClientTokenForAgent(
    authClient.sub,
    agentId,
    body.clientToken,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({
    agentId,
    clientToken: result.value.clientToken,
  });
};

export const requestMyClientAgents = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const body = getValidated<ClientAgentIdsBody>(response, "body");
  const result = await container.clientAgentAccessService.requestAccess(
    authClient.sub,
    body.agentIds,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json(result.value);
};

export const removeMyClientAgents = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const body = getValidated<ClientAgentIdsBody>(response, "body");
  const result = await container.clientAgentAccessService.removeApprovedAccess(
    authClient.sub,
    body.agentIds,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ message: "Client agent accesses removed successfully" });
};

export const removeMyClientAgentByParam = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const { agentId } = getValidated<ClientAgentIdParam>(response, "params");
  const result = await container.clientAgentAccessService.removeApprovedAccess(authClient.sub, [
    agentId,
  ]);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ message: "Client agent accesses removed successfully" });
};

export const listMyClientAgentAccessRequests = async (
  _request: Request,
  response: Response,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const query = getValidated<ClientListAgentAccessRequestsQuery>(response, "query");
  const pageResult = await container.clientAgentAccessService.listRequestsPage(authClient.sub, {
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.search !== undefined ? { search: query.search } : {}),
    ...(query.page !== undefined ? { page: query.page } : {}),
    ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
  });
  response.status(200).json({
    requests: pageResult.items.map(toClientAgentAccessRequestDto),
    count: pageResult.items.length,
    total: pageResult.total,
    page: pageResult.page,
    pageSize: pageResult.pageSize,
  });
};

export const retryMyClientAgentAccessRequest = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authClient = getAuthClient(response);
  const { requestId } = getValidated<ClientAgentAccessRequestIdParam>(response, "params");
  const result = await container.clientAgentAccessService.retryRequestByClient(
    authClient.sub,
    requestId,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json(result.value);
};

/** GET: read-only page with POST forms (no mutating GET). */
export const clientAccessReviewPage = (_request: Request, response: Response): void => {
  const { token } = getValidated<ClientAccessReviewTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const approveAction = `${base}/api/v1/client-access/approve`;
  const rejectAction = `${base}/api/v1/client-access/reject`;
  const html = renderApprovalReviewPage({
    title: "Review client access",
    eyebrow: "Agent access approval",
    description:
      "Approve this request only if the client should access this agent. GET requests do not change data.",
    approveAction,
    rejectAction,
    token,
    approveLabel: "Approve access",
    rejectLabel: "Reject access",
    reasonLabel: "Optional note to the client (max 500 characters)",
  });

  response.status(200).type("html").send(html);
};

export const approveClientAccess = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientAccessApproveBody>(response, "body");
  const result = await container.clientAgentAccessService.approveByToken(body.token);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response
    .status(200)
    .type("html")
    .send(
      decisionHtml(
        "Client access approved",
        `The client now has access to agent ${result.value.agentId}.`,
        "success",
      ),
    );
};

export const rejectClientAccess = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<ClientAccessRejectBody>(response, "body");
  const result = await container.clientAgentAccessService.rejectByToken(body.token, body.reason);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response
    .status(200)
    .type("html")
    .send(
      decisionHtml(
        "Client access rejected",
        `The access request for agent ${result.value.agentId} was rejected.`,
        "danger",
      ),
    );
};

export const clientAccessStatus = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const { token } = getValidated<ClientAccessReviewTokenQuery>(response, "query");
  const result = await container.clientAgentAccessService.getRequestStatusByToken(token);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json(result.value);
};

const toClientAgentAccessRequestDto = (request: {
  id: string;
  clientId: string;
  agentId: string;
  agentName?: string;
  status: "pending" | "approved" | "rejected" | "expired" | "revoked";
  requestedAt: Date;
  decidedAt?: Date;
  decisionReason?: string;
}): {
  id: string;
  clientId: string;
  agentId: string;
  agentName: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "revoked";
  requestedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
} => ({
  id: request.id,
  clientId: request.clientId,
  agentId: request.agentId,
  agentName: request.agentName ?? null,
  status: request.status,
  requestedAt: request.requestedAt.toISOString(),
  decidedAt: request.decidedAt?.toISOString() ?? null,
  decisionReason: request.decisionReason ?? null,
});
