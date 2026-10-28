import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import { forbidden } from "../../shared/errors/http_errors";

export interface PwaOfflineAuthorization {
  readonly version: 1;
  readonly userId: string;
  readonly agentIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** A local-read lease, never an API authentication credential. */
export class PwaOfflineAuthorizationService {
  constructor(
    private readonly access: IClientAgentAccessRepository,
    private readonly agents: IAgentRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async issue(clientId: string, requestedIds: readonly string[]): Promise<PwaOfflineAuthorization> {
    const allowed = await this.access.listAccessAgentIdsForClientIn(clientId, requestedIds);
    if (allowed.length !== requestedIds.length) throw forbidden("Agent access denied");
    const agents = await this.agents.findByIds([...allowed]);
    if (agents.length !== allowed.length || agents.some((agent) => agent.status !== "active")) {
      throw forbidden("Agent access unavailable");
    }
    const issuedAt = this.clock();
    return {
      version: 1,
      userId: clientId,
      agentIds: [...allowed].sort(),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }
}
