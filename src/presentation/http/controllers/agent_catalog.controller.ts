import type { Request, Response, NextFunction } from "express";
import { canReadAgentByLink } from "../../../application/policies/agent_visibility.policy";
import { container } from "../../../shared/di/container";
import { forbidden } from "../../../shared/errors/http_errors";
import { sendJsonWithWeakETag } from "../helpers/weak_etag";
import { getValidated } from "../middlewares/validate.middleware";
import { getAuthUser } from "../middlewares/auth.middleware";
import type { AgentIdParam, ListAgentsQuery } from "../validators/agent_catalog.validator";
import { toAgentCatalogDto } from "../serializers/agent_catalog.serializer";

export { toAgentCatalogDto };

export const listAgents = async (request: Request, response: Response): Promise<void> => {
  const authUser = getAuthUser(response);
  const query = getValidated<ListAgentsQuery>(response, "query");

  const baseFilter = {
    ...(query?.status !== undefined ? { status: query.status } : {}),
    ...(query?.search !== undefined ? { search: query.search } : {}),
    ...(query?.page !== undefined ? { page: query.page } : {}),
    ...(query?.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
  };
  const pageResult = await container.agentCatalogService.listVisiblePage(authUser, baseFilter);
  const payload = {
    agents: pageResult.items.map(toAgentCatalogDto),
    count: pageResult.items.length,
    total: pageResult.total,
    page: pageResult.page,
    pageSize: pageResult.pageSize,
  };
  /**
   * Catalog reads change rarely; a weak ETag lets pollers short-circuit with
   * 304 when nothing moved. Headers preserved on both 200 and 304 paths.
   */
  sendJsonWithWeakETag(request, response, payload);
};

export const getAgent = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const authUser = getAuthUser(response);
  const { agentId } = getValidated<AgentIdParam>(response, "params");

  const hasAccess = await canReadAgentByLink(authUser, agentId, (userId, id) =>
    container.userAgentService.isAgentLinkedToUser(userId, id),
  );
  if (!hasAccess) {
    next(forbidden("Insufficient permissions"));
    return;
  }

  const result = await container.agentCatalogService.findById(agentId);
  if (!result.ok) {
    next(result.error);
    return;
  }
  const payload = { agent: toAgentCatalogDto(result.value) };
  sendJsonWithWeakETag(request, response, payload);
};

export const deactivateAgent = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const { agentId } = getValidated<AgentIdParam>(response, "params");
  const result = await container.agentCatalogService.deactivate(agentId);
  if (!result.ok) {
    next(result.error);
    return;
  }
  response.status(200).json({ agent: toAgentCatalogDto(result.value) });
};
