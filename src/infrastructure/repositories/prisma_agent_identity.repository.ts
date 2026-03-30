import type {
  BindAgentIdentityStatus,
  IAgentIdentityRepository,
} from "../../domain/repositories/agent_identity.repository.interface";
import { prismaClient } from "../database/prisma/client";

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

  async addAgentIds(userId: string, agentIds: string[]): Promise<void> {
    await prismaClient.agentIdentity.createMany({
      data: agentIds.map((agentId) => ({ agentId, userId })),
      skipDuplicates: true,
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

  async replaceAgentIds(userId: string, agentIds: string[]): Promise<void> {
    await prismaClient.$transaction([
      prismaClient.agentIdentity.deleteMany({ where: { userId } }),
      prismaClient.agentIdentity.createMany({
        data: agentIds.map((agentId) => ({ agentId, userId })),
        skipDuplicates: true,
      }),
    ]);
  }
}
