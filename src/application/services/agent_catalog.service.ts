import type { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";
import { notFound } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export class AgentCatalogService {
  constructor(private readonly agentRepository: IAgentRepository) {}

  async deactivate(agentId: string): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(notFound(`Agent ${agentId}`));
    }

    const deactivated = agent.deactivate();
    await this.agentRepository.update(deactivated);
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
