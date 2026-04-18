import type { NextFunction, Request, Response } from "express";

import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { getAuthClient } from "../middlewares/auth.middleware";
import { escapeHtml, escapeHtmlAttr } from "../helpers/html_escape";
import { getValidated } from "../middlewares/validate.middleware";
import type {
  ClientAccessApproveBody,
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

const decisionHtml = (title: string, bodyText: string): string => {
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
  maybeSetHubInstanceIdHeader(response);
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
  maybeSetHubInstanceIdHeader(response);
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

/** GET: read-only page with POST forms (no mutating GET). */
export const clientAccessReviewPage = (_request: Request, response: Response): void => {
  const { token } = getValidated<ClientAccessReviewTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const approveAction = `${base}/api/v1/client-access/approve`;
  const rejectAction = `${base}/api/v1/client-access/reject`;
  const safeToken = escapeHtmlAttr(token);

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Review client access</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;">
  <h1>Review client access</h1>
  <p>Submitting a form below will approve or reject client access. GET requests do not change data.</p>
  <form method="post" action="${approveAction}" style="margin-bottom:1.5rem;">
    <input type="hidden" name="token" value="${safeToken}"/>
    <button type="submit" style="padding:10px 16px;background:#0d6efd;color:#fff;border:none;border-radius:6px;cursor:pointer;">Approve access</button>
  </form>
  <form method="post" action="${rejectAction}">
    <input type="hidden" name="token" value="${safeToken}"/>
    <label for="reason">Optional note to the client (max 500 characters)</label><br/>
    <textarea id="reason" name="reason" rows="3" cols="50" maxlength="500" style="margin:0.5rem 0;"></textarea><br/>
    <button type="submit" style="padding:10px 16px;background:#dc3545;color:#fff;border:none;border-radius:6px;cursor:pointer;">Reject access</button>
  </form>
</body>
</html>`;

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

const maybeSetHubInstanceIdHeader = (response: Response): void => {
  const id = env.hubInstanceId.trim();
  if (id !== "") {
    response.setHeader("X-Hub-Instance-Id", id);
  }
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
