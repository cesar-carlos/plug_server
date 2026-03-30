import { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
} from "../../domain/repositories/agent.repository.interface";
import { prismaClient } from "../database/prisma/client";

export class PrismaAgentRepository implements IAgentRepository {
  async findById(agentId: string): Promise<Agent | null> {
    const record = await prismaClient.agent.findUnique({ where: { agentId } });
    return record ? this.toEntity(record) : null;
  }

  async findByCnpjCpf(cnpjCpf: string): Promise<Agent | null> {
    const record = await prismaClient.agent.findUnique({ where: { cnpjCpf } });
    return record ? this.toEntity(record) : null;
  }

  async findAll(filter?: AgentListFilter): Promise<Agent[]> {
    const records = await prismaClient.agent.findMany({
      where: {
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.search
          ? {
              OR: [
                { name: { contains: filter.search, mode: "insensitive" } },
                { cnpjCpf: { contains: filter.search } },
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
    });
    return records.map(this.toEntity);
  }

  async save(agent: Agent): Promise<void> {
    await prismaClient.agent.create({
      data: {
        agentId: agent.agentId,
        name: agent.name,
        cnpjCpf: agent.cnpjCpf,
        observation: agent.observation ?? null,
        status: agent.status,
      },
    });
  }

  async update(agent: Agent): Promise<void> {
    await prismaClient.agent.update({
      where: { agentId: agent.agentId },
      data: {
        name: agent.name,
        cnpjCpf: agent.cnpjCpf,
        observation: agent.observation ?? null,
        status: agent.status,
      },
    });
  }

  private toEntity(record: {
    agentId: string;
    name: string;
    cnpjCpf: string;
    observation: string | null;
    status: "active" | "inactive";
    createdAt: Date;
    updatedAt: Date;
  }): Agent {
    return Agent.create({
      agentId: record.agentId,
      name: record.name,
      cnpjCpf: record.cnpjCpf,
      ...(record.observation !== null ? { observation: record.observation } : {}),
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}
