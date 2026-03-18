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
}
