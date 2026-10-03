import type {
  AgentListFilter,
  PaginatedAgentList,
} from "../repositories/agent.repository.interface";

export type AgentCatalogScope =
  { readonly kind: "all" } | { readonly kind: "user"; readonly userId: string };

export interface IAgentCatalogQueryPort {
  findCatalogPage(scope: AgentCatalogScope, filter?: AgentListFilter): Promise<PaginatedAgentList>;
}
