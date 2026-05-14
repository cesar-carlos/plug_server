import type { Prisma } from "@prisma/client";

import { Agent } from "../../domain/entities/agent.entity";
import type {
  ClientApprovedAgentListFilter,
  ClientApprovedAgentListPage,
  ClientAgentAccessRecord,
  IClientAgentAccessRepository,
} from "../../domain/repositories/client_agent_access.repository.interface";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientAgentAccessRepository implements IClientAgentAccessRepository {
  async hasAccess(clientId: string, agentId: string): Promise<boolean> {
    const row = await prismaClient.clientAgentAccess.findUnique({
      where: {
        clientId_agentId: {
          clientId,
          agentId,
        },
      },
      select: { clientId: true },
    });
    return row !== null;
  }

  async listAccessAgentIdsForClientIn(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<string[]> {
    if (agentIds.length === 0) {
      return [];
    }
    const unique = [...new Set(agentIds)];
    const rows = await prismaClient.clientAgentAccess.findMany({
      where: { clientId, agentId: { in: unique } },
      select: { agentId: true },
    });
    return rows.map((r) => r.agentId);
  }

  async listAgentIdsByClientId(clientId: string): Promise<string[]> {
    const rows = await prismaClient.clientAgentAccess.findMany({
      where: { clientId },
      select: { agentId: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((item) => item.agentId);
  }

  async listClientTokenPresenceForClientIn(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, boolean>> {
    if (agentIds.length === 0) {
      return new Map();
    }
    const unique = [...new Set(agentIds)];
    const rows = await prismaClient.clientAgentAccess.findMany({
      where: { clientId, agentId: { in: unique } },
      select: { agentId: true, clientToken: true },
    });
    return new Map(
      rows.map(
        (row) =>
          [row.agentId, typeof row.clientToken === "string" && row.clientToken !== ""] as const,
      ),
    );
  }

  async listApprovedAgentsPageByClient(
    clientId: string,
    filter?: ClientApprovedAgentListFilter,
  ): Promise<ClientApprovedAgentListPage> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);
    const agentWhere: Prisma.AgentWhereInput = {
      ...(filter?.status !== undefined ? { status: filter.status } : {}),
      ...(filter?.search !== undefined && filter.search.trim() !== ""
        ? {
            OR: [
              { name: { contains: filter.search, mode: "insensitive" as const } },
              { tradeName: { contains: filter.search, mode: "insensitive" as const } },
              { document: { contains: filter.search } },
            ],
          }
        : {}),
    };
    const where: Prisma.ClientAgentAccessWhereInput = {
      clientId,
      ...(Object.keys(agentWhere).length > 0 ? { agent: agentWhere } : {}),
    };

    const [rows, total] = await Promise.all([
      prismaClient.clientAgentAccess.findMany({
        where,
        include: { agent: true },
        orderBy: [{ agent: { name: "asc" } }, { agentId: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prismaClient.clientAgentAccess.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        agent: this.toAgentEntity(row.agent),
        hasClientToken: typeof row.clientToken === "string" && row.clientToken !== "",
      })),
      total,
      page,
      pageSize,
    };
  }

  async listActiveClientIdsByAgentId(agentId: string): Promise<string[]> {
    const rows = await prismaClient.clientAgentAccess.findMany({
      where: { agentId, client: { status: "active" } },
      select: { clientId: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => row.clientId);
  }

  async listByAgentId(agentId: string): Promise<ClientAgentAccessRecord[]> {
    const rows = await prismaClient.clientAgentAccess.findMany({
      where: { agentId },
      select: {
        clientId: true,
        agentId: true,
        approvedAt: true,
        clientToken: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((item) => ({
      clientId: item.clientId,
      agentId: item.agentId,
      approvedAt: item.approvedAt,
      clientToken: item.clientToken ?? null,
    }));
  }

  async findByClientAndAgent(
    clientId: string,
    agentId: string,
  ): Promise<ClientAgentAccessRecord | null> {
    const row = await prismaClient.clientAgentAccess.findUnique({
      where: { clientId_agentId: { clientId, agentId } },
      select: {
        clientId: true,
        agentId: true,
        approvedAt: true,
        clientToken: true,
      },
    });
    if (!row) {
      return null;
    }
    return {
      clientId: row.clientId,
      agentId: row.agentId,
      approvedAt: row.approvedAt,
      clientToken: row.clientToken ?? null,
    };
  }

  async addAccess(clientId: string, agentId: string, approvedAt?: Date): Promise<void> {
    await prismaClient.clientAgentAccess.upsert({
      where: { clientId_agentId: { clientId, agentId } },
      create: {
        clientId,
        agentId,
        ...(approvedAt ? { approvedAt } : {}),
      },
      update: {
        ...(approvedAt ? { approvedAt } : {}),
      },
    });
  }

  async setClientToken(
    clientId: string,
    agentId: string,
    clientToken: string | null,
  ): Promise<boolean> {
    // `updateMany` lets us avoid throwing when the row does not exist (no
    // P2025), so the caller can decide between 404 vs creating-on-demand.
    const result = await prismaClient.clientAgentAccess.updateMany({
      where: { clientId, agentId },
      data: { clientToken },
    });
    return result.count > 0;
  }

  async removeAccess(clientId: string, agentId: string): Promise<void> {
    await prismaClient.clientAgentAccess.deleteMany({
      where: {
        clientId,
        agentId,
      },
    });
  }

  async removeAgentIds(clientId: string, agentIds: string[]): Promise<void> {
    const uniqueAgentIds = [...new Set(agentIds)];
    if (uniqueAgentIds.length === 0) {
      return;
    }
    await prismaClient.clientAgentAccess.deleteMany({
      where: {
        clientId,
        agentId: { in: uniqueAgentIds },
      },
    });
  }

  private toAgentEntity(record: {
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
    profileVersion: number;
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
      profileVersion: record.profileVersion,
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
