import type {
  ClientAgentAccessApproveTxnInput,
  ClientAgentAccessRejectTxnInput,
  IClientAgentAccessApprovalTxn,
} from "../../domain/ports/client_agent_access_approval_txn.port";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientAgentAccessApprovalTxn implements IClientAgentAccessApprovalTxn {
  async approvePendingAndGrantAccess(input: ClientAgentAccessApproveTxnInput): Promise<boolean> {
    return prismaClient.$transaction(async (tx) => {
      const updated = await tx.clientAgentAccessRequest.updateMany({
        where: { id: input.requestId, status: "pending" },
        data: {
          status: "approved",
          decidedAt: input.approvedAt,
          decisionReason: null,
        },
      });
      if (updated.count !== 1) {
        return false;
      }

      await tx.clientAgentAccess.upsert({
        where: {
          clientId_agentId: {
            clientId: input.clientId,
            agentId: input.agentId,
          },
        },
        create: {
          clientId: input.clientId,
          agentId: input.agentId,
          approvedAt: input.approvedAt,
        },
        update: {
          approvedAt: input.approvedAt,
        },
      });

      if (input.consumeTokenId !== undefined) {
        await tx.clientAgentAccessApprovalToken.deleteMany({
          where: { id: input.consumeTokenId },
        });
      } else {
        await tx.clientAgentAccessApprovalToken.deleteMany({
          where: { requestId: input.requestId },
        });
      }

      return true;
    });
  }

  async rejectPendingAndConsumeToken(input: ClientAgentAccessRejectTxnInput): Promise<boolean> {
    return prismaClient.$transaction(async (tx) => {
      const updated = await tx.clientAgentAccessRequest.updateMany({
        where: { id: input.requestId, status: "pending" },
        data: {
          status: "rejected",
          decidedAt: input.decidedAt,
          decisionReason: input.reason ?? null,
        },
      });
      if (updated.count !== 1) {
        return false;
      }

      if (input.consumeTokenId !== undefined) {
        await tx.clientAgentAccessApprovalToken.deleteMany({
          where: { id: input.consumeTokenId },
        });
      } else {
        await tx.clientAgentAccessApprovalToken.deleteMany({
          where: { requestId: input.requestId },
        });
      }

      return true;
    });
  }
}
