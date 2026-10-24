import type { AgentCatalogScope } from "../../domain/ports/agent_catalog_query.port";
import type {
  AgentListFilter,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";
import { logger } from "../../shared/utils/logger";
import type { AgentCatalogGeneration } from "../ports/agent_catalog_generation.port";

const MAX_CATALOG_PAGES = 64;

export const agentCatalogPageKey = (scope: AgentCatalogScope, filter?: AgentListFilter): string => {
  const agentIds = filter?.agentIds === undefined ? "" : [...filter.agentIds].sort().join(",");
  return JSON.stringify({
    scope: scope.kind === "all" ? "all" : scope.userId,
    status: filter?.status ?? null,
    search: filter?.search ?? null,
    page: filter?.page ?? null,
    pageSize: filter?.pageSize ?? null,
    agentIds,
  });
};

/** Keeps catalog pages only while their generation still matches the shared revision. */
export class AgentCatalogPageCache {
  private readonly entries = new Map<
    string,
    { readonly generation: number; readonly page: PaginatedAgentList }
  >();

  constructor(private readonly generation: AgentCatalogGeneration) {}

  async load(key: string, load: () => Promise<PaginatedAgentList>): Promise<PaginatedAgentList> {
    const generation = await this.generation.read();
    if (generation === null) {
      this.entries.clear();
      return load();
    }
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.generation === generation) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.page;
    }
    const page = await load();
    this.remember(key, generation, page);
    return page;
  }

  async bump(): Promise<void> {
    this.entries.clear();
    try {
      await this.generation.bump();
    } catch (error) {
      logger.warn("agent_catalog_generation_bump_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private remember(key: string, generation: number, page: PaginatedAgentList): void {
    this.entries.delete(key);
    this.entries.set(key, { generation, page });
    while (this.entries.size > MAX_CATALOG_PAGES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
