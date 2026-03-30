import { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";
import { conflict, notFound } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";
import { validateCnpjCpf } from "../../shared/utils/cnpj_cpf";

export interface CreateAgentInput {
  readonly agentId: string;
  readonly name: string;
  readonly cnpjCpf: string;
  readonly observation?: string;
}

export interface UpdateAgentInput {
  readonly name?: string;
  readonly cnpjCpf?: string;
  readonly observation?: string | null;
}

export class AgentCatalogService {
  constructor(private readonly agentRepository: IAgentRepository) {}

  async create(input: CreateAgentInput): Promise<Result<Agent>> {
    const cnpjCpfResult = validateCnpjCpf(input.cnpjCpf);
    if (!cnpjCpfResult.ok) return cnpjCpfResult;
    const normalizedCnpjCpf = cnpjCpfResult.value;

    const existing = await this.agentRepository.findById(input.agentId);
    if (existing) {
      return err(conflict("Agent ID already registered"));
    }

    const byCnpjCpf = await this.agentRepository.findByCnpjCpf(normalizedCnpjCpf);
    if (byCnpjCpf) {
      return err(conflict("CPF/CNPJ already registered for another agent"));
    }

    const trimmedObs = input.observation?.trim();
    const agent = Agent.create({
      agentId: input.agentId,
      name: input.name.trim(),
      cnpjCpf: normalizedCnpjCpf,
      ...(trimmedObs ? { observation: trimmedObs } : {}),
    });

    await this.agentRepository.save(agent);
    return ok(agent);
  }

  async update(agentId: string, input: UpdateAgentInput): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(notFound(`Agent ${agentId}`));
    }

    let normalizedCnpjCpf: string | undefined;
    if (input.cnpjCpf !== undefined) {
      const cnpjCpfResult = validateCnpjCpf(input.cnpjCpf);
      if (!cnpjCpfResult.ok) return cnpjCpfResult;
      normalizedCnpjCpf = cnpjCpfResult.value;

      if (normalizedCnpjCpf !== agent.cnpjCpf) {
        const byCnpjCpf = await this.agentRepository.findByCnpjCpf(normalizedCnpjCpf);
        if (byCnpjCpf && byCnpjCpf.agentId !== agentId) {
          return err(conflict("CPF/CNPJ already registered for another agent"));
        }
      }
    }

    const updated = agent.update({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(normalizedCnpjCpf !== undefined ? { cnpjCpf: normalizedCnpjCpf } : {}),
      ...(input.observation === null
        ? { observation: null }
        : input.observation !== undefined
          ? { observation: input.observation.trim() }
          : {}),
    });

    await this.agentRepository.update(updated);
    return ok(updated);
  }

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
