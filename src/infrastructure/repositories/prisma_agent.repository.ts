import { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
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

  async findByIds(agentIds: string[]): Promise<Agent[]> {
    if (agentIds.length === 0) {
      return [];
    }

    const records = await prismaClient.agent.findMany({
      where: { agentId: { in: [...new Set(agentIds)] } },
    });

    return records.map((record) => this.toEntity(record));
  }

  async findAll(filter?: AgentListFilter): Promise<PaginatedAgentList> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);

    if (filter?.agentIds !== undefined && filter.agentIds.length === 0) {
      return {
        items: [],
        total: 0,
        page,
        pageSize,
      };
    }

    const where = {
      ...(filter?.agentIds !== undefined && filter.agentIds.length > 0
        ? { agentId: { in: [...new Set(filter.agentIds)] } }
        : {}),
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.search
        ? {
            OR: [
              { name: { contains: filter.search, mode: "insensitive" as const } },
              { cnpjCpf: { contains: filter.search } },
            ],
          }
        : {}),
    };

    const [records, total] = await Promise.all([
      prismaClient.agent.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prismaClient.agent.count({ where }),
    ]);

    return {
      items: records.map((record) => this.toEntity(record)),
      total,
      page,
      pageSize,
    };
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
