import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
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

  async listByAgentId(
    agentId: string,
  ): Promise<Array<{ clientId: string; agentId: string; approvedAt: Date }>> {
    const rows = await prismaClient.clientAgentAccess.findMany({
      where: { agentId },
      select: {
        clientId: true,
        agentId: true,
        approvedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((item) => ({
      clientId: item.clientId,
      agentId: item.agentId,
      approvedAt: item.approvedAt,
    }));
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
}
