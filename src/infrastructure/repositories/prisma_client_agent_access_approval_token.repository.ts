import type { ClientAgentAccessApprovalToken as PrismaToken } from "@prisma/client";

import type {
  ClientAgentAccessApprovalToken,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientAgentAccessApprovalTokenRepository
  implements IClientAgentAccessApprovalTokenRepository
{
  async save(token: ClientAgentAccessApprovalToken): Promise<void> {
    await prismaClient.clientAgentAccessApprovalToken.upsert({
      where: { requestId: token.requestId },
      create: {
        id: token.id,
        requestId: token.requestId,
        expiresAt: token.expiresAt,
        createdAt: token.createdAt,
      },
      update: {
        id: token.id,
        expiresAt: token.expiresAt,
      },
    });
  }

  async findById(id: string): Promise<ClientAgentAccessApprovalToken | null> {
    const row = await prismaClient.clientAgentAccessApprovalToken.findUnique({
      where: { id },
    });
    return row ? this.toDomain(row) : null;
  }

  async deleteById(id: string): Promise<void> {
    await prismaClient.clientAgentAccessApprovalToken.deleteMany({
      where: { id },
    });
  }

  private toDomain(row: PrismaToken): ClientAgentAccessApprovalToken {
    return {
      id: row.id,
      requestId: row.requestId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
}
