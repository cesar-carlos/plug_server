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
import type {
  CreateAgentBody,
  UpdateAgentBody,
  AgentIdParam,
  ListAgentsQuery,
} from "../validators/agent_catalog.validator";

export const createAgent = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = getValidated<CreateAgentBody>(response, "body");
    const result = await container.agentCatalogService.create({
      agentId: body.agentId,
      name: body.name,
      cnpjCpf: body.cnpjCpf,
      ...(body.observation !== undefined ? { observation: body.observation } : {}),
    });
    if (!result.ok) {
      next(result.error);
      return;
    }
    response.status(201).json({ agent: toDto(result.value) });
  } catch (e) {
    next(e);
  }
};

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

export const updateAgent = async (
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { agentId } = getValidated<AgentIdParam>(response, "params");
    const body = getValidated<UpdateAgentBody>(response, "body");
    const result = await container.agentCatalogService.update(agentId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.cnpjCpf !== undefined ? { cnpjCpf: body.cnpjCpf } : {}),
      ...(body.observation !== undefined ? { observation: body.observation } : {}),
    });
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
  cnpjCpf: string;
  observation: string | null;
  status: Agent["status"];
  createdAt: string;
  updatedAt: string;
} => ({
  agentId: agent.agentId,
  name: agent.name,
  cnpjCpf: agent.cnpjCpf,
  observation: agent.observation ?? null,
  status: agent.status,
  createdAt: agent.createdAt.toISOString(),
  updatedAt: agent.updatedAt.toISOString(),
});
