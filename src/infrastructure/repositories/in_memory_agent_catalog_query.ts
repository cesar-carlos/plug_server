import type {
  AgentCatalogScope,
  IAgentCatalogQueryPort,
} from "../../domain/ports/agent_catalog_query.port";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";

export class InMemoryAgentCatalogQuery implements IAgentCatalogQueryPort {
  constructor(
    private readonly agents: IAgentRepository,
    private readonly identities: IAgentIdentityRepository,
  ) {}
  async findCatalogPage(
    scope: AgentCatalogScope,
    filter?: AgentListFilter,
  ): Promise<PaginatedAgentList> {
    if (scope.kind === "all") return this.agents.findAll(filter);
    const linked = await this.identities.listAgentIdsByUserId(scope.userId);
    const allowed = filter?.agentIds === undefined ? undefined : new Set(filter.agentIds);
    const permitted = allowed === undefined ? linked : linked.filter((id) => allowed.has(id));
    return this.agents.findAll({ ...filter, agentIds: permitted });
  }
}
