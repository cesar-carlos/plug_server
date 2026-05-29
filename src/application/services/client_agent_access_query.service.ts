import type { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
} from "../../domain/repositories/agent.repository.interface";
import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";
import { agentAccessDenied, notFound } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import {
  AgentSnapshotRefresher,
  type ClientAgentLiveProfileDeps,
} from "./agent_snapshot_refresher";
import { loadAgentsById, toRequestRecord } from "./client_agent_access_request_records";
import type {
  ApprovedClientAgentListPage,
  ClientAgentAccessRequestRecord,
} from "./client_agent_access_types";

/**
 * Read-only queries about a client's approved agents and the per-(client,
 * agent) bearer token presence. Owns the `AgentSnapshotRefresher` collaborator
 * because online-aware listing/detail endpoints need live snapshots while
 * the rest of the access subsystem (request/decision/token) does not.
 */
export class ClientAgentAccessQueryService {
  private readonly snapshotRefresher: AgentSnapshotRefresher;

  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly clientRepository: IClientRepository,
    private readonly clientAgentAccessRepository: IClientAgentAccessRepository,
    private readonly clientAgentAccessRequestRepository: IClientAgentAccessRequestRepository,
    liveProfileDeps?: ClientAgentLiveProfileDeps,
  ) {
    this.snapshotRefresher = new AgentSnapshotRefresher(agentRepository, liveProfileDeps);
  }

  async listApprovedAgentIds(clientId: string): Promise<string[]> {
    return this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
  }

  /** Client IDs with approved access to this agent (for realtime fan-out). */
  async listApprovedClientIdsForAgent(agentId: string): Promise<string[]> {
    const accesses = await this.clientAgentAccessRepository.listByAgentId(agentId);
    return accesses.map((access) => access.clientId);
  }

  /** Active client IDs with approved access to this agent (for realtime fan-out). */
  async listActiveApprovedClientIdsForAgent(agentId: string): Promise<string[]> {
    if (this.clientAgentAccessRepository.listActiveClientIdsByAgentId !== undefined) {
      return this.clientAgentAccessRepository.listActiveClientIdsByAgentId(agentId);
    }
    const accesses = await this.clientAgentAccessRepository.listByAgentId(agentId);
    return this.clientRepository.findActiveIdsByIds(accesses.map((access) => access.clientId));
  }

  async listApprovedAgents(clientId: string): Promise<Agent[]> {
    const agentIds = await this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
    const agents = await this.agentRepository.findByIds(agentIds);
    const agentsById = new Map(agents.map((agent) => [agent.agentId, agent] as const));
    return agentIds
      .map((agentId) => agentsById.get(agentId))
      .filter((agent): agent is Agent => agent !== undefined);
  }

  async listApprovedAgentsPage(
    clientId: string,
    filter?: AgentListFilter,
    options?: { readonly refreshOnline?: boolean },
  ): Promise<ApprovedClientAgentListPage> {
    if (this.clientAgentAccessRepository.listApprovedAgentsPageByClient !== undefined) {
      const pageResult = await this.clientAgentAccessRepository.listApprovedAgentsPageByClient(
        clientId,
        filter,
      );
      if (options?.refreshOnline !== true) {
        return pageResult;
      }
      return {
        ...pageResult,
        items: await this.snapshotRefresher.refreshListItems(clientId, pageResult.items),
      };
    }

    const agentIds = await this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
    const pageResult = await this.agentRepository.findAll({
      ...(filter ?? {}),
      agentIds,
    });
    const pageAgents =
      options?.refreshOnline !== true
        ? pageResult.items
        : (
            await this.snapshotRefresher.refreshListItems(
              clientId,
              pageResult.items.map((agent) => ({ agent, hasClientToken: false })),
            )
          ).map((item) => item.agent);
    const tokenPresenceByAgent =
      await this.clientAgentAccessRepository.listClientTokenPresenceForClientIn(
        clientId,
        pageAgents.map((agent) => agent.agentId),
      );
    return {
      ...pageResult,
      items: pageAgents.map((agent) => ({
        agent,
        hasClientToken: tokenPresenceByAgent.get(agent.agentId) === true,
      })),
    };
  }

  async findApprovedAgent(clientId: string, agentId: string): Promise<Result<Agent>> {
    const hasAccess = await this.clientAgentAccessRepository.hasAccess(clientId, agentId);
    if (!hasAccess) {
      return err(agentAccessDenied(agentId));
    }

    const persistedAgent = await this.agentRepository.findById(agentId);
    if (!persistedAgent) {
      return err(notFound(`Agent ${agentId}`));
    }

    return ok(
      await this.snapshotRefresher.resolvePreferredSnapshot(clientId, agentId, persistedAgent),
    );
  }

  /**
   * Bulk presence map: for each `agentId` in `agentIds`, returns whether the
   * client has stored a non-empty `client_token`. Used by the listing endpoint
   * to expose `hasClientToken` without leaking the actual token value.
   */
  async getClientTokenPresenceForAgents(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, boolean>> {
    return this.clientAgentAccessRepository.listClientTokenPresenceForClientIn(clientId, agentIds);
  }

  /** Convenience for single-agent detail endpoints (`findApprovedAgent` companion). */
  async hasClientTokenForAgent(clientId: string, agentId: string): Promise<boolean> {
    const access = await this.clientAgentAccessRepository.findByClientAndAgent(clientId, agentId);
    return access !== null && typeof access.clientToken === "string" && access.clientToken !== "";
  }

  async listRequests(clientId: string): Promise<ClientAgentAccessRequestRecord[]> {
    const requests = await this.clientAgentAccessRequestRepository.listByClientId(clientId);
    const agentsById = await loadAgentsById(
      this.agentRepository,
      requests.map((request) => request.agentId),
    );
    return requests.map((request) =>
      toRequestRecord(
        Object.assign(
          request,
          agentsById.get(request.agentId)?.name !== undefined
            ? { agentName: agentsById.get(request.agentId)!.name }
            : {},
        ),
      ),
    );
  }
}
