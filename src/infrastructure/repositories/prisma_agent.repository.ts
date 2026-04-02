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

  async findByDocument(document: string): Promise<Agent | null> {
    const record = await prismaClient.agent.findUnique({ where: { document } });
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
              { tradeName: { contains: filter.search, mode: "insensitive" as const } },
              { document: { contains: filter.search } },
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
        tradeName: agent.tradeName ?? null,
        document: agent.document ?? null,
        documentType: agent.documentType ?? null,
        phone: agent.phone ?? null,
        mobile: agent.mobile ?? null,
        email: agent.email ?? null,
        street: agent.street ?? null,
        number: agent.number ?? null,
        district: agent.district ?? null,
        postalCode: agent.postalCode ?? null,
        city: agent.city ?? null,
        state: agent.state ?? null,
        notes: agent.notes ?? null,
        profileUpdatedAt: agent.profileUpdatedAt ?? null,
        lastLoginUserId: agent.lastLoginUserId ?? null,
        status: agent.status,
      },
    });
  }

  async update(agent: Agent): Promise<void> {
    await prismaClient.agent.update({
      where: { agentId: agent.agentId },
      data: {
        name: agent.name,
        tradeName: agent.tradeName ?? null,
        document: agent.document ?? null,
        documentType: agent.documentType ?? null,
        phone: agent.phone ?? null,
        mobile: agent.mobile ?? null,
        email: agent.email ?? null,
        street: agent.street ?? null,
        number: agent.number ?? null,
        district: agent.district ?? null,
        postalCode: agent.postalCode ?? null,
        city: agent.city ?? null,
        state: agent.state ?? null,
        notes: agent.notes ?? null,
        profileUpdatedAt: agent.profileUpdatedAt ?? null,
        lastLoginUserId: agent.lastLoginUserId ?? null,
        status: agent.status,
      },
    });
  }

  private toEntity(record: {
    agentId: string;
    name: string;
    tradeName: string | null;
    document: string | null;
    documentType: "cpf" | "cnpj" | null;
    phone: string | null;
    mobile: string | null;
    email: string | null;
    street: string | null;
    number: string | null;
    district: string | null;
    postalCode: string | null;
    city: string | null;
    state: string | null;
    notes: string | null;
    profileUpdatedAt: Date | null;
    lastLoginUserId: string | null;
    status: "active" | "inactive";
    createdAt: Date;
    updatedAt: Date;
  }): Agent {
    return Agent.create({
      agentId: record.agentId,
      name: record.name,
      ...(record.tradeName !== null ? { tradeName: record.tradeName } : {}),
      ...(record.document !== null ? { document: record.document } : {}),
      ...(record.documentType !== null ? { documentType: record.documentType } : {}),
      ...(record.phone !== null ? { phone: record.phone } : {}),
      ...(record.mobile !== null ? { mobile: record.mobile } : {}),
      ...(record.email !== null ? { email: record.email } : {}),
      ...(record.notes !== null ? { notes: record.notes } : {}),
      ...(record.profileUpdatedAt !== null ? { profileUpdatedAt: record.profileUpdatedAt } : {}),
      ...(record.lastLoginUserId !== null ? { lastLoginUserId: record.lastLoginUserId } : {}),
      address: {
        ...(record.street !== null ? { street: record.street } : {}),
        ...(record.number !== null ? { number: record.number } : {}),
        ...(record.district !== null ? { district: record.district } : {}),
        ...(record.postalCode !== null ? { postalCode: record.postalCode } : {}),
        ...(record.city !== null ? { city: record.city } : {}),
        ...(record.state !== null ? { state: record.state } : {}),
      },
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}
