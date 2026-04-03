import { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import {
  agentAccessDenied,
  agentAlreadyLinked,
  agentInactive,
  agentNotFound,
} from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export type AgentAccessPrincipal =
  | { readonly type: "user"; readonly id: string; readonly role?: string }
  | { readonly type: "client"; readonly id: string };

export class AgentAccessService {
  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
    private readonly clientAgentAccessRepository: IClientAgentAccessRepository,
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
    return this.assertPrincipalAccess({ type: "user", id: userId }, agentId);
  }

  /**
   * Asserts that:
   * 1. The agent exists in the catalog.
   * 2. The agent status is "active".
   * 3. The principal has explicit access to the agent.
   */
  async assertPrincipalAccess(principal: AgentAccessPrincipal, agentId: string): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(agentNotFound(agentId));
    }

    if (agent.status !== "active") {
      return err(agentInactive(agentId));
    }

    const hasAccess =
      principal.type === "user"
        ? principal.role === "admin"
          ? true
          : await this.agentIdentityRepository.hasAccess(principal.id, agentId)
        : await this.clientAgentAccessRepository.hasAccess(principal.id, agentId);
    if (!hasAccess) {
      return err(agentAccessDenied(agentId));
    }

    return ok(agent);
  }

  /**
   * Allows agent login when the agent is either missing from the catalog or active,
   * and is either unbound or already owned by the same user. Ownership is not created here.
   */
  async assertAgentLoginAllowed(userId: string, agentId: string): Promise<Result<void>> {
    return this.assertOwnershipEligible(userId, agentId);
  }

  /**
   * Confirms ownership when the agent completes agent:register after a valid agent-login.
   */
  async bindOwnershipOnRegister(userId: string, agentId: string): Promise<Result<void>> {
    const allowed = await this.assertOwnershipEligible(userId, agentId);
    if (!allowed.ok) {
      return allowed;
    }

    // `agent_identities.agent_id` FK-references `agents`. Catalog rows are normally filled by
    // profile sync after register; ensure a stub exists before inserting identity.
    await this.ensureCatalogAgentExistsForIdentity(agentId, userId);

    const status = await this.agentIdentityRepository.bindIfUnbound(agentId, userId);
    if (status === "bound_to_other_user") {
      return err(agentAlreadyLinked(agentId));
    }

    return ok(undefined);
  }

  /**
   * Asserts that the agent exists and is active, without checking user binding.
   * Used for operations that only need to verify agent operability.
   */
  async assertAgentOperational(agentId: string): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(agentNotFound(agentId));
    }

    if (agent.status !== "active") {
      return err(agentInactive(agentId));
    }

    return ok(agent);
  }

  private async ensureCatalogAgentExistsForIdentity(agentId: string, userId: string): Promise<void> {
    const existing = await this.agentRepository.findById(agentId);
    if (existing) {
      return;
    }

    const stub = Agent.create({
      agentId,
      name: `Agent ${agentId}`,
      lastLoginUserId: userId,
      status: "active",
    });

    try {
      await this.agentRepository.save(stub);
    } catch (e) {
      const race = await this.agentRepository.findById(agentId);
      if (race) {
        return;
      }
      throw e;
    }
  }

  private async assertOwnershipEligible(userId: string, agentId: string): Promise<Result<void>> {
    const ownerUserId = await this.agentIdentityRepository.findOwnerUserId(agentId);
    if (ownerUserId !== null && ownerUserId !== userId) {
      return err(agentAlreadyLinked(agentId));
    }

    const agent = await this.agentRepository.findById(agentId);
    if (agent && agent.status !== "active") {
      return err(agentInactive(agentId));
    }

    return ok(undefined);
  }
}
