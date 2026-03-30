import { Prisma } from "@prisma/client";
import type {
  AgentIdentityMutationResult,
  BindAgentIdentityStatus,
  IAgentIdentityRepository,
} from "../../domain/repositories/agent_identity.repository.interface";
import { prismaClient } from "../database/prisma/client";

const okResult: AgentIdentityMutationResult = { kind: "ok" };

export class PrismaAgentIdentityRepository implements IAgentIdentityRepository {
  async findOwnerUserId(agentId: string): Promise<string | null> {
    const identity = await prismaClient.agentIdentity.findUnique({
      where: { agentId },
      select: { userId: true },
    });

    return identity?.userId ?? null;
  }

  async bindIfUnbound(agentId: string, userId: string): Promise<BindAgentIdentityStatus> {
    const createResult = await prismaClient.agentIdentity.createMany({
      data: [{ agentId, userId }],
      skipDuplicates: true,
    });

    if (createResult.count === 1) {
      return "bound";
    }

    const existing = await prismaClient.agentIdentity.findUnique({
      where: { agentId },
      select: { userId: true },
    });

    if (!existing) {
      return "bound_to_other_user";
    }

    if (existing.userId === userId) {
      return "already_bound_to_user";
    }

    return "bound_to_other_user";
  }

  async hasAccess(userId: string, agentId: string): Promise<boolean> {
    const identity = await prismaClient.agentIdentity.findUnique({
      where: { agentId },
      select: { userId: true },
    });
    return identity?.userId === userId;
  }

  async listAgentIdsByUserId(userId: string): Promise<string[]> {
    const identities = await prismaClient.agentIdentity.findMany({
      where: { userId },
      select: { agentId: true },
      orderBy: { createdAt: "asc" },
    });
    return identities.map((i) => i.agentId);
  }

  async addAgentIds(userId: string, agentIds: string[]): Promise<AgentIdentityMutationResult> {
    const uniqueAgentIds = [...new Set(agentIds)];
    if (uniqueAgentIds.length === 0) {
      return okResult;
    }

    return prismaClient.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const lockedAgentIds = await this.lockAgents(tx, uniqueAgentIds);
      const missingAgentId = uniqueAgentIds.find((agentId) => !lockedAgentIds.has(agentId));
      if (missingAgentId) {
        return { kind: "agent_not_found", agentId: missingAgentId };
      }

      const existingIdentities = await tx.agentIdentity.findMany({
        where: { agentId: { in: uniqueAgentIds } },
        select: { agentId: true, userId: true },
      });
      const conflict = existingIdentities.find((identity) => identity.userId !== userId);
      if (conflict) {
        return {
          kind: "agent_bound_to_other_user",
          agentId: conflict.agentId,
          ownerUserId: conflict.userId,
        };
      }

      const alreadyLinked = new Set(existingIdentities.map((identity) => identity.agentId));
      const agentIdsToInsert = uniqueAgentIds.filter((agentId) => !alreadyLinked.has(agentId));

      if (agentIdsToInsert.length > 0) {
        await tx.agentIdentity.createMany({
          data: agentIdsToInsert.map((agentId) => ({ agentId, userId })),
        });
      }

      return okResult;
    });
  }

  async removeAgentIds(userId: string, agentIds: string[]): Promise<void> {
    await prismaClient.agentIdentity.deleteMany({
      where: {
        userId,
        agentId: { in: agentIds },
      },
    });
  }

  async replaceAgentIds(userId: string, agentIds: string[]): Promise<AgentIdentityMutationResult> {
    const uniqueAgentIds = [...new Set(agentIds)];

    return prismaClient.$transaction(async (tx) => {
      await this.lockUser(tx, userId);

      if (uniqueAgentIds.length > 0) {
        const lockedAgentIds = await this.lockAgents(tx, uniqueAgentIds);
        const missingAgentId = uniqueAgentIds.find((agentId) => !lockedAgentIds.has(agentId));
        if (missingAgentId) {
          return { kind: "agent_not_found", agentId: missingAgentId };
        }

        const existingIdentities = await tx.agentIdentity.findMany({
          where: { agentId: { in: uniqueAgentIds } },
          select: { agentId: true, userId: true },
        });
        const conflict = existingIdentities.find((identity) => identity.userId !== userId);
        if (conflict) {
          return {
            kind: "agent_bound_to_other_user",
            agentId: conflict.agentId,
            ownerUserId: conflict.userId,
          };
        }
      }

      await tx.agentIdentity.deleteMany({ where: { userId } });

      if (uniqueAgentIds.length > 0) {
        await tx.agentIdentity.createMany({
          data: uniqueAgentIds.map((agentId) => ({ agentId, userId })),
        });
      }

      return okResult;
    });
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  }

  private async lockAgents(tx: Prisma.TransactionClient, agentIds: string[]): Promise<Set<string>> {
    const rows = await tx.$queryRaw<Array<{ agent_id: string }>>(
      Prisma.sql`
        SELECT agent_id
        FROM agents
        WHERE agent_id IN (${Prisma.join(agentIds)})
        FOR UPDATE
      `,
    );

    return new Set(rows.map((row) => row.agent_id));
  }
}
