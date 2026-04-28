import type { ClientAgentAccessRequestStatus as PrismaClientAgentAccessRequestStatus } from "@prisma/client";

import type { ClientAgentAccessRequest } from "../../domain/entities/client_agent_access_request.entity";
import type { IPendingClientAgentAccessWriter } from "../../domain/ports/pending_client_agent_access_writer.port";
import type { ClientAgentAccessApprovalToken } from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import { prismaClient } from "../database/prisma/client";

export class PrismaPendingClientAgentAccessWriter implements IPendingClientAgentAccessWriter {
  async writePendingRequests(
    items: ReadonlyArray<{
      readonly request: ClientAgentAccessRequest;
      readonly token: ClientAgentAccessApprovalToken;
    }>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await prismaClient.$transaction(async (tx) => {
      for (const { request, token } of items) {
        await tx.clientAgentAccessRequest.upsert({
          where: { id: request.id },
          create: {
            id: request.id,
            clientId: request.clientId,
            agentId: request.agentId,
            status: request.status as PrismaClientAgentAccessRequestStatus,
            requestedAt: request.requestedAt,
            ...(request.decidedAt !== undefined ? { decidedAt: request.decidedAt } : {}),
            ...(request.decisionReason !== undefined
              ? { decisionReason: request.decisionReason }
              : {}),
            retryCount: request.retryCount,
            createdAt: request.createdAt,
            updatedAt: request.updatedAt,
          },
          update: {
            status: request.status as PrismaClientAgentAccessRequestStatus,
            requestedAt: request.requestedAt,
            decidedAt: request.decidedAt ?? null,
            decisionReason: request.decisionReason ?? null,
            retryCount: request.retryCount,
            updatedAt: request.updatedAt,
          },
        });
        await tx.clientAgentAccessApprovalToken.upsert({
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
    });
  }
}
