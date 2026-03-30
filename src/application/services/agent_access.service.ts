import type { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import { forbidden, notFound } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export class AgentAccessService {
  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
  ) {}

  /**
   * Asserts that:
   * 1. The agent exists in the catalog.
   * 2. The agent status is "active".
   * 3. The user has an explicit binding to the agent.
   *
   * Returns the agent entity on success so callers do not need to re-fetch.
   */
  async assertAccess(userId: string, agentId: string): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(notFound(`Agent ${agentId}`));
    }

    if (agent.status !== "active") {
      return err(forbidden("Agent is inactive and cannot be used"));
    }

    const hasAccess = await this.agentIdentityRepository.hasAccess(userId, agentId);
    if (!hasAccess) {
      return err(forbidden("You do not have access to this agent"));
    }

    return ok(agent);
  }

  /**
   * Asserts that the agent exists and is active, without checking user binding.
   * Used for operations that only need to verify agent operability.
   */
  async assertAgentOperational(agentId: string): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(notFound(`Agent ${agentId}`));
    }

    if (agent.status !== "active") {
      return err(forbidden("Agent is inactive and cannot be used"));
    }

    return ok(agent);
  }
}
