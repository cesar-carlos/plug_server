import type {
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
}
