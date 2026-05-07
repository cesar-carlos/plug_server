import type { Request, Response, NextFunction } from "express";
import {
  canReadAgentByLink,
  resolveVisibleAgentIds,
} from "../../../application/policies/agent_visibility.policy";
import { container } from "../../../shared/di/container";
import { forbidden } from "../../../shared/errors/http_errors";
import { getValidated } from "../middlewares/validate.middleware";
import { getAuthUser } from "../middlewares/auth.middleware";
import type { AgentIdParam, ListAgentsQuery } from "../validators/agent_catalog.validator";
import { toAgentCatalogDto } from "../serializers/agent_catalog.serializer";

export { toAgentCatalogDto };

export const listAgents = async (_request: Request, response: Response): Promise<void> => {
  const authUser = getAuthUser(response);
  const query = getValidated<ListAgentsQuery>(response, "query");

  const baseFilter = {
    ...(query?.status !== undefined ? { status: query.status } : {}),
    ...(query?.search !== undefined ? { search: query.search } : {}),
    ...(query?.page !== undefined ? { page: query.page } : {}),
    ...(query?.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
  };
  const visibleAgentIds = await resolveVisibleAgentIds(authUser, (userId) =>
    container.userAgentService.listAgentIdsByUserId(userId),
  );

  const pageResult = await container.agentCatalogService.listAll(
    visibleAgentIds === undefined
      ? baseFilter
      : {
          ...baseFilter,
          agentIds: visibleAgentIds,
        },
  );
  response.status(200).json({
    agents: pageResult.items.map(toAgentCatalogDto),
    count: pageResult.items.length,
    total: pageResult.total,
    page: pageResult.page,
    pageSize: pageResult.pageSize,
  });
};

export const getAgent = async (
  _request: Request,
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
  response.status(200).json({ agent: toAgentCatalogDto(result.value) });
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
