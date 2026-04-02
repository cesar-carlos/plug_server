import type { Request, Response, NextFunction } from "express";
import type { Agent } from "../../../domain/entities/agent.entity";
import {
  canReadAgentByLink,
  resolveVisibleAgentIds,
} from "../../../application/policies/agent_visibility.policy";
import { container } from "../../../shared/di/container";
import { forbidden } from "../../../shared/errors/http_errors";
import { getValidated } from "../middlewares/validate.middleware";
import { getAuthUser } from "../middlewares/auth.middleware";
import type { AgentIdParam, ListAgentsQuery } from "../validators/agent_catalog.validator";

export const listAgents = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
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
      agents: pageResult.items.map(toDto),
      count: pageResult.items.length,
      total: pageResult.total,
      page: pageResult.page,
      pageSize: pageResult.pageSize,
    });
  } catch (e) {
    next(e);
  }
};

export const getAgent = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
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
    response.status(200).json({ agent: toDto(result.value) });
  } catch (e) {
    next(e);
  }
};

export const deactivateAgent = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { agentId } = getValidated<AgentIdParam>(response, "params");
    const result = await container.agentCatalogService.deactivate(agentId);
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(200).json({ agent: toDto(result.value) });
  } catch (e) {
    next(e);
  }
};

const toDto = (
  agent: Agent,
): {
  agentId: string;
  name: string;
  tradeName: string | null;
  document: string | null;
  cnpjCpf: string | null;
  documentType: Agent["documentType"] | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  address: {
    street: string | null;
    number: string | null;
    district: string | null;
    postalCode: string | null;
    city: string | null;
    state: string | null;
  };
  notes: string | null;
  observation: string | null;
  lastLoginUserId: string | null;
  profileUpdatedAt: string | null;
  status: Agent["status"];
  createdAt: string;
  updatedAt: string;
} => ({
  agentId: agent.agentId,
  name: agent.name,
  tradeName: agent.tradeName ?? null,
  document: agent.document ?? null,
  cnpjCpf: agent.document ?? null,
  documentType: agent.documentType ?? null,
  phone: agent.phone ?? null,
  mobile: agent.mobile ?? null,
  email: agent.email ?? null,
  address: {
    street: agent.street ?? null,
    number: agent.number ?? null,
    district: agent.district ?? null,
    postalCode: agent.postalCode ?? null,
    city: agent.city ?? null,
    state: agent.state ?? null,
  },
  notes: agent.notes ?? null,
  observation: agent.notes ?? null,
  lastLoginUserId: agent.lastLoginUserId ?? null,
  profileUpdatedAt: agent.profileUpdatedAt?.toISOString() ?? null,
  status: agent.status,
  createdAt: agent.createdAt.toISOString(),
  updatedAt: agent.updatedAt.toISOString(),
});
