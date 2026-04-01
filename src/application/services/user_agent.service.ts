import type { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type { AgentOnlinePresencePort } from "../ports/agent_online_presence.port";
import {
  agentAlreadyLinked,
  agentInactive,
  agentNotFound,
  agentNotOnlineForUser,
} from "../../shared/errors/http_errors";
import { incrementUserAgentsSelfBindPost } from "../../shared/metrics/user_agents_self_bind.metrics";
import { type Result, ok, err } from "../../shared/errors/result";

export interface EnrichedAgent {
  readonly agentId: string;
  readonly name: string;
  readonly cnpjCpf: string;
  readonly observation: string | undefined;
  readonly status: Agent["status"];
}

export class UserAgentService {
  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
    private readonly agentOnlinePresence: AgentOnlinePresencePort,
  ) {}

  /** Whether the user has an explicit user↔agent binding (does not require agent status active). */
  async isAgentLinkedToUser(userId: string, agentId: string): Promise<boolean> {
    return this.agentIdentityRepository.hasAccess(userId, agentId);
  }

  async listAgentIdsByUserId(userId: string): Promise<string[]> {
    return this.agentIdentityRepository.listAgentIdsByUserId(userId);
  }

  async listByUserId(userId: string): Promise<EnrichedAgent[]> {
    const agentIds = await this.agentIdentityRepository.listAgentIdsByUserId(userId);
    const agents = await this.agentRepository.findByIds(agentIds);
    const agentsById = new Map(agents.map((agent) => [agent.agentId, agent] as const));

    return agentIds
      .map((agentId) => agentsById.get(agentId))
      .filter((agent): agent is Agent => agent !== undefined)
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        cnpjCpf: agent.cnpjCpf,
        observation: agent.observation,
        status: agent.status,
      }));
  }

  /**
   * Self-service: persists like {@link addAgentIds}, but each agent must be `active` in the catalog
   * and online on the hub under this user (see {@link AgentOnlinePresencePort}).
   */
  async addSelfAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    const unique = [...new Set(agentIds)];

    for (const agentId of unique) {
      const agent = await this.agentRepository.findById(agentId);
      if (!agent) {
        incrementUserAgentsSelfBindPost("not_found");
        return err(agentNotFound(agentId));
      }
      if (agent.status !== "active") {
        incrementUserAgentsSelfBindPost("inactive");
        return err(agentInactive(agentId));
      }

      const presence = await this.agentOnlinePresence.resolvePresenceForUser(agentId, userId);
      if (presence.kind === "offline") {
        incrementUserAgentsSelfBindPost("not_online_offline");
        return err(agentNotOnlineForUser(agentId, "offline"));
      }
      if (presence.kind === "online_other_user") {
        incrementUserAgentsSelfBindPost("not_online_other");
        return err(agentNotOnlineForUser(agentId, "different_account"));
      }
    }

    const persisted = await this.persistAddAgentIds(userId, unique);
    if (!persisted.ok) {
      const { error } = persisted;
      if (error.code === "AGENT_ALREADY_LINKED") {
        incrementUserAgentsSelfBindPost("already_linked");
      } else if (error.code === "AGENT_NOT_FOUND") {
        incrementUserAgentsSelfBindPost("not_found");
      }
      return persisted;
    }

    incrementUserAgentsSelfBindPost("success");
    return ok(undefined);
  }

  async addAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    const unique = [...new Set(agentIds)];

    for (const agentId of unique) {
      const agent = await this.agentRepository.findById(agentId);
      if (!agent) {
        return err(agentNotFound(agentId));
      }
    }

    return this.persistAddAgentIds(userId, unique);
  }

  private async persistAddAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    const mutation = await this.agentIdentityRepository.addAgentIds(userId, agentIds);
    if (mutation.kind === "agent_not_found") {
      return err(agentNotFound(mutation.agentId));
    }
    if (mutation.kind === "agent_bound_to_other_user") {
      return err(agentAlreadyLinked(mutation.agentId));
    }

    return ok(undefined);
  }

  async removeAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    await this.agentIdentityRepository.removeAgentIds(userId, agentIds);
    return ok(undefined);
  }

  async replaceAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    const unique = [...new Set(agentIds)];

    for (const agentId of unique) {
      const agent = await this.agentRepository.findById(agentId);
      if (!agent) {
        return err(agentNotFound(agentId));
      }
    }

    const mutation = await this.agentIdentityRepository.replaceAgentIds(userId, unique);
    if (mutation.kind === "agent_not_found") {
      return err(agentNotFound(mutation.agentId));
    }
    if (mutation.kind === "agent_bound_to_other_user") {
      return err(agentAlreadyLinked(mutation.agentId));
    }

    return ok(undefined);
  }
}
