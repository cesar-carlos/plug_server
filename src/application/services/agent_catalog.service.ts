import type { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";
import { notFound } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export interface AgentCatalogDeps {
  /** Called after an agent is deactivated. Use to bust per-agent access caches. */
  readonly onAgentDeactivated?: (agentId: string) => void;
}

export class AgentCatalogService {
  constructor(
    private readonly agentRepository: IAgentRepository,
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

  async listAll(filter?: AgentListFilter): Promise<PaginatedAgentList> {
    return this.agentRepository.findAll(filter);
  }
}
