import type { ClientAgentAccessApprovalToken as PrismaToken } from "@prisma/client";

import type {
  ClientAgentAccessApprovalToken,
  ClientAgentAccessApprovalReviewSummaryRecord,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import type { ClientAgentAccessRequestStatus } from "../../domain/entities/client_agent_access_request.entity";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientAgentAccessApprovalTokenRepository implements IClientAgentAccessApprovalTokenRepository {
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

  async findReviewSummaryById(
    id: string,
  ): Promise<ClientAgentAccessApprovalReviewSummaryRecord | null> {
    const row = await prismaClient.clientAgentAccessApprovalToken.findUnique({
      where: { id },
      select: {
        expiresAt: true,
        request: {
          select: {
            agentId: true,
            status: true,
            client: {
              select: {
                email: true,
                name: true,
                lastName: true,
              },
            },
            agent: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    if (!row) {
      return null;
    }

    return {
      clientEmail: row.request.client.email,
      clientName: `${row.request.client.name} ${row.request.client.lastName}`.trim(),
      agentId: row.request.agentId,
      agentName: row.request.agent.name,
      requestStatus: row.request.status as ClientAgentAccessRequestStatus,
      expiresAt: row.expiresAt,
    };
  }

  async deleteById(id: string): Promise<void> {
    await prismaClient.clientAgentAccessApprovalToken.deleteMany({
      where: { id },
    });
  }

  async deleteByRequestId(requestId: string): Promise<void> {
    await prismaClient.clientAgentAccessApprovalToken.deleteMany({
      where: { requestId },
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
