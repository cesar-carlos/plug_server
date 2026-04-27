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

const clientAccessHome = (): { homeUrl: string; homeLabel: string } => {
  const homeUrl = env.appBaseUrl.replace(/\/+$/, "");
  return { homeUrl, homeLabel: "Voltar ao início" };
};

const clientAccessDecisionHtml = (
  title: string,
  bodyText: string,
  tone: "success" | "danger" | "neutral",
): string => {
  const { homeUrl, homeLabel } = clientAccessHome();
  return renderApprovalDecisionPage({
    title,
    bodyText,
    tone,
    lang: "pt-BR",
    decisionEyebrow: "Decisão registrada",
    homeUrl,
    homeLabel,
  });
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
export const clientAccessReviewPage = async (
  _request: Request,
  response: Response,
): Promise<void> => {
  const { token } = getValidated<ClientAccessReviewTokenQuery>(response, "query");
  const base = env.appBaseUrl.replace(/\/+$/, "");
  const { homeUrl, homeLabel } = clientAccessHome();
  const approveAction = `${base}/api/v1/client-access/approve`;
  const rejectAction = `${base}/api/v1/client-access/reject`;
  const summary = await container.clientAgentAccessService.getReviewSummaryByToken(token);

  let showActionForms = true;
  let readOnlyMessage: string | undefined;
  if (summary === null) {
    showActionForms = false;
    readOnlyMessage =
      "Este link é inválido, expirou ou já foi utilizado. Nenhuma ação é necessária nesta página.";
  } else if (summary.tokenStatus === "expired") {
    showActionForms = false;
    readOnlyMessage =
      "Este link de aprovação expirou. Se o acesso ainda for necessário, o cliente pode solicitar novamente.";
  } else if (summary.requestStatus !== "pending") {
    showActionForms = false;
    readOnlyMessage = `Este pedido de acesso já foi resolvido (status: ${summary.requestStatus}).`;
  }

  const html = renderApprovalReviewPage({
    title: "Revisar acesso do cliente",
    eyebrow: "Aprovação de acesso ao agente",
    description:
      "Aprovar somente se o cliente deve acessar este agente. Requisições GET não alteram dados.",
    approveAction,
    rejectAction,
    token,
    approveLabel: "Aprovar acesso",
    rejectLabel: "Recusar acesso",
    reasonLabel: "Mensagem opcional para o cliente (máx. 500 caracteres)",
    showActionForms,
    homeUrl,
    homeLabel,
    lang: "pt-BR",
    textareaPlaceholder: "Nota opcional",
    actionsAriaLabel: "Ações de aprovação",
    ...(!showActionForms && readOnlyMessage !== undefined ? { readOnlyMessage } : {}),
    ...(summary === null
      ? {}
      : {
          summaryItems: [
            { label: "Cliente", value: summary.clientName },
            { label: "E-mail", value: summary.clientEmail },
            {
              label: "Agente",
              value:
                summary.agentName !== undefined
                  ? `${summary.agentName} (${summary.agentId})`
                  : summary.agentId,
            },
            { label: "Status do pedido", value: summary.requestStatus },
            { label: "Status do link", value: summary.tokenStatus },
          ],
        }),
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
      clientAccessDecisionHtml(
        "Acesso aprovado",
        `O cliente agora tem acesso ao agente ${result.value.agentId}.`,
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
      clientAccessDecisionHtml(
        "Acesso recusado",
        `A solicitação de acesso ao agente ${result.value.agentId} foi recusada.`,
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
