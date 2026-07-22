import type { ClientAgentAccessRequest } from "../../domain/entities/client_agent_access_request.entity";
import type { Agent } from "../../domain/entities/agent.entity";
import type { Client } from "../../domain/entities/client.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type {
  ClientAgentAccessRequestRecord,
  ClientAgentAccessRequestListFilter,
  ClientAgentAccessRequestPage,
} from "./client_agent_access_types";

/**
 * Pure helpers used by query/request/decision services. Kept in a module
 * (not a class) because they have no dependencies and represent
 * presentation-shape conversions or in-memory filtering.
 */

export const toRequestRecord = (
  request: ClientAgentAccessRequest & { readonly agentName?: string },
): ClientAgentAccessRequestRecord => ({
  id: request.id,
  clientId: request.clientId,
  agentId: request.agentId,
  ...(request.agentName !== undefined ? { agentName: request.agentName } : {}),
  status: request.status,
  retryCount: request.retryCount,
  requestedAt: request.requestedAt,
  ...(request.decidedAt !== undefined ? { decidedAt: request.decidedAt } : {}),
  ...(request.decisionReason !== undefined ? { decisionReason: request.decisionReason } : {}),
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

export const filterRequestRecords = (
  items: ClientAgentAccessRequestRecord[],
  filter?: ClientAgentAccessRequestListFilter,
): ClientAgentAccessRequestRecord[] => {
  let filtered = items;
  if (filter?.status !== undefined) {
    filtered = filtered.filter((request) => request.status === filter.status);
  }
  if (filter?.search !== undefined && filter.search.trim() !== "") {
    const query = filter.search.trim().toLowerCase();
    filtered = filtered.filter(
      (request) =>
        request.agentId.toLowerCase().includes(query) ||
        (request.agentName?.toLowerCase().includes(query) ?? false),
    );
  }
  return filtered;
};

export const paginateRequestRecords = (
  items: ClientAgentAccessRequestRecord[],
  page: number,
  pageSize: number,
): ClientAgentAccessRequestPage => {
  const total = items.length;
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total,
    page,
    pageSize,
  };
};

export const loadAgentsById = async (
  agentRepository: Pick<IAgentRepository, "findByIds">,
  agentIds: readonly string[],
): Promise<Map<string, Agent>> => {
  const uniqueAgentIds = [...new Set(agentIds)];
  const agents = await agentRepository.findByIds(uniqueAgentIds);
  return new Map(agents.map((agent) => [agent.agentId, agent] as const));
};

export const loadClientsById = async (
  clientRepository: Pick<IClientRepository, "findByIds">,
  clientIds: readonly string[],
): Promise<Map<string, Client>> => {
  const clients = await clientRepository.findByIds(clientIds);
  const map = new Map<string, Client>();
  for (const client of clients) {
    map.set(client.id, client);
  }
  return map;
};
