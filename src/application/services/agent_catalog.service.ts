import type { IAgentCatalogQueryPort } from "../../domain/ports/agent_catalog_query.port";
import type { JwtAccessPayload } from "../../shared/utils/jwt";
import { isJwtAdmin } from "../policies/agent_visibility.policy";
import type { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";
import { notFound } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";
import { type AgentCatalogPageCache, agentCatalogPageKey } from "./agent_catalog_page_cache";

export interface AgentCatalogDeps {
  /** Called after an agent is deactivated. Use to bust per-agent access caches. */
  readonly onAgentDeactivated?: (agentId: string) => void;
  /** Optional page cache. Absent callers always read the catalog query. */
  readonly pages?: AgentCatalogPageCache;
}

export class AgentCatalogService {
  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly catalogQuery: IAgentCatalogQueryPort,
    private readonly deps?: AgentCatalogDeps,
  ) {}

  async deactivate(agentId: string): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(notFound(`Agent ${agentId}`));
    }

    const deactivated = agent.deactivate();
    await this.agentRepository.update(deactivated);
    this.deps?.onAgentDeactivated?.(agentId);
    return ok(deactivated);
  }

  async findById(agentId: string): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(notFound(`Agent ${agentId}`));
    }
    return ok(agent);
  }

  async listVisiblePage(
    principal: JwtAccessPayload,
    filter?: AgentListFilter,
  ): Promise<PaginatedAgentList> {
    const scope = isJwtAdmin(principal)
      ? { kind: "all" as const }
      : { kind: "user" as const, userId: principal.sub };
    const load = (): Promise<PaginatedAgentList> =>
      this.catalogQuery.findCatalogPage(scope, filter);
    const pages = this.deps?.pages;
    if (pages === undefined) return load();
    return pages.load(agentCatalogPageKey(scope, filter), load);
  }

  async listAll(filter?: AgentListFilter): Promise<PaginatedAgentList> {
    return this.agentRepository.findAll(filter);
  }
}
