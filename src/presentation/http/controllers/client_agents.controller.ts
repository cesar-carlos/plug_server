import type { NextFunction, Request, Response } from "express";

import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { getAuthClient } from "../middlewares/auth.middleware";
import { negotiateApprovalHtmlLang } from "../helpers/approval_page_locale";
import {
  clientAccessDecisionCopy,
  clientAccessReviewCopy,
} from "../helpers/approval_registration_i18n";
import { renderApprovalReviewPage } from "../helpers/approval_pages";
import { approvalHome, renderApprovalDecisionHtml } from "../helpers/approval_decision_html";
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

export const listMyClientAgents = async (_request: Request, response: Response): Promise<void> => {
  const authClient = getAuthClient(response);
  const query = getValidated<ClientListAgentsQuery>(response, "query");
  const pageResult = await container.clientAgentAccessQueryService.listApprovedAgentsPage(
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
  const agentIdsOnPage = pageResult.items.map((item) => item.agent.agentId);
  const connectedAgentIds =
    (await container.restAgentBridgeService.resolveClusterConnectedAgentIds?.(agentIdsOnPage)) ??
    container.restAgentBridgeService.getConnectedAgentIdSet();
  const agents = pageResult.items.map((item) =>
    toClientAgentDto(item.agent, connectedAgentIds.has(item.agent.agentId), item.hasClientToken),
  );
  recordClientMeAgentsListResponse(agents.filter((a) => a.isHubConnected).length);
  response.status(200).json({
    agents,
    agentIds: pageResult.items.map((item) => item.agent.agentId),
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
  // Authorize first; skip token/presence reads when access is denied.
  const result = await container.clientAgentAccessQueryService.findApprovedAgent(
    authClient.sub,
    agentId,
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  const [hasClientToken, isHubConnected] = await Promise.all([
    container.clientAgentAccessQueryService.hasClientTokenForAgent(authClient.sub, agentId),
    (async (): Promise<boolean> =>
      (await container.restAgentBridgeService.isAgentConnectedCluster?.(agentId)) ??
      container.restAgentBridgeService.isAgentConnected(agentId))(),
  ]);
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
  const result = await container.clientAgentTokenService.getClientTokenForAgent(
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
  const result = await container.clientAgentTokenService.setClientTokenForAgent(
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
  const result = await container.clientAgentAccessRequestService.requestAccess(
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
  const result = await container.clientAgentAccessRequestService.removeApprovedAccess(
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
  const result = await container.clientAgentAccessRequestService.removeApprovedAccess(
    authClient.sub,
    [agentId],
  );
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
  const pageResult = await container.clientAgentAccessRequestService.listRequestsPage(
    authClient.sub,
    {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
    },
  );
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
  const result = await container.clientAgentAccessRequestService.retryRequestByClient(
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
export const clientAccessReviewPage = async (
  request: Request,
  response: Response,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const copy = clientAccessReviewCopy(lang);
  const { token } = getValidated<ClientAccessReviewTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const { homeUrl, homeLabel } = approvalHome(lang);
  const approveAction = `${base}/api/v1/client-access/approve`;
  const rejectAction = `${base}/api/v1/client-access/reject`;
  const summary = await container.clientAgentAccessDecisionService.getReviewSummaryByToken(token);

  let showActionForms = true;
  let readOnlyMessage: string | undefined;
  if (summary === null) {
    showActionForms = false;
    readOnlyMessage = copy.readOnlyInvalid;
  } else if (summary.tokenStatus === "expired") {
    showActionForms = false;
    readOnlyMessage = copy.readOnlyExpired;
  } else if (summary.requestStatus !== "pending") {
    showActionForms = false;
    readOnlyMessage = copy.readOnlyResolved(summary.requestStatus);
  }

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
    showActionForms,
    homeUrl,
    homeLabel,
    lang,
    textareaPlaceholder: copy.textareaPlaceholder,
    actionsAriaLabel: copy.actionsAriaLabel,
    ...(!showActionForms && readOnlyMessage !== undefined ? { readOnlyMessage } : {}),
    ...(summary === null
      ? {}
      : {
          summaryItems: [
            { label: copy.summaryClient, value: summary.clientName },
            { label: copy.summaryEmail, value: summary.clientEmail },
            {
              label: copy.summaryAgent,
              value:
                summary.agentName !== undefined
                  ? `${summary.agentName} (${summary.agentId})`
                  : summary.agentId,
            },
            { label: copy.summaryRequestStatus, value: summary.requestStatus },
            { label: copy.summaryLinkStatus, value: summary.tokenStatus },
          ],
        }),
  });

  response.status(200).type("html").send(html);
};

export const approveClientAccess = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const decision = clientAccessDecisionCopy(lang);
  const body = getValidated<ClientAccessApproveBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.clientAgentAccessDecisionService.approveByToken(body.token, {
    ...(requestId !== undefined ? { requestId } : {}),
  });
  if (!result.ok) {
    next(result.error);
    return;
  }
  response
    .status(200)
    .type("html")
    .send(
      renderApprovalDecisionHtml(
        lang,
        decision.approvedTitle,
        decision.approvedBody(result.value.agentId),
        "success",
      ),
    );
};

export const rejectClientAccess = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const lang = negotiateApprovalHtmlLang(request);
  const decision = clientAccessDecisionCopy(lang);
  const body = getValidated<ClientAccessRejectBody>(response, "body");
  const requestId = response.locals.requestId as string | undefined;
  const result = await container.clientAgentAccessDecisionService.rejectByToken(
    body.token,
    body.reason,
    {
      ...(requestId !== undefined ? { requestId } : {}),
    },
  );
  if (!result.ok) {
    next(result.error);
    return;
  }
  response
    .status(200)
    .type("html")
    .send(
      renderApprovalDecisionHtml(
        lang,
        decision.rejectedTitle,
        decision.rejectedBody(result.value.agentId),
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
  const result = await container.clientAgentAccessDecisionService.getRequestStatusByToken(token);
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
  status: request.status,
  retryCount: request.retryCount,
  requestedAt: request.requestedAt.toISOString(),
  decidedAt: request.decidedAt?.toISOString() ?? null,
  decisionReason: request.decisionReason ?? null,
  createdAt: request.createdAt.toISOString(),
  updatedAt: request.updatedAt.toISOString(),
});
