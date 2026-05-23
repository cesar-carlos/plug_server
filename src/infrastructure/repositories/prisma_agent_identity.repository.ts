import type {
  BindAgentIdentityStatus,
  IAgentIdentityRepository,
  UserAgentIdListPage,
  UserAgentListFilter,
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

  async findOwnerUserIdsByAgentIds(agentIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(agentIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await prismaClient.agentIdentity.findMany({
      where: { agentId: { in: unique } },
      select: { agentId: true, userId: true },
    });
    return new Map(rows.map((r) => [r.agentId, r.userId] as const));
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
    return identities.map((identity) => identity.agentId);
  }

  async listAgentIdsPageByUserId(
    userId: string,
    filter?: UserAgentListFilter,
  ): Promise<UserAgentIdListPage> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, filter?.pageSize ?? 20));
    const where = { userId };

    const [identities, total] = await Promise.all([
      prismaClient.agentIdentity.findMany({
        where,
        select: { agentId: true },
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prismaClient.agentIdentity.count({ where }),
    ]);

    return {
      agentIds: identities.map((identity) => identity.agentId),
      total,
      page,
      pageSize,
    };
  }
}
