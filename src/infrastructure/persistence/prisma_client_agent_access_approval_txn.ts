import { enqueuePwaDeliveries } from "./enqueue_pwa_deliveries";
import type {
  ClientAgentAccessApproveTxnInput,
  ClientAgentAccessRejectTxnInput,
  ClientAgentAccessRevokeTxnInput,
  IClientAgentAccessApprovalTxn,
} from "../../domain/ports/client_agent_access_approval_txn.port";
import { prismaClient } from "../database/prisma/client";
import { runPrismaTransactionWithRetry } from "./prisma_transaction_retry";

export class PrismaClientAgentAccessApprovalTxn implements IClientAgentAccessApprovalTxn {
  async approvePendingAndGrantAccess(input: ClientAgentAccessApproveTxnInput): Promise<boolean> {
    return runPrismaTransactionWithRetry("client_agent_access_approve", () =>
      prismaClient.$transaction(async (tx) => {
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

        if (input.pushEventId) {
          await enqueuePwaDeliveries(tx, input.clientId, {
            type: "access-approved",
            eventId: input.pushEventId,
          });
        }
        return true;
      }),
    );
  }

  async revokeAccess(input: ClientAgentAccessRevokeTxnInput): Promise<boolean> {
    return runPrismaTransactionWithRetry("client_agent_access_revoke", () =>
      prismaClient.$transaction(async (tx) => {
        const removed = await tx.clientAgentAccess.deleteMany({
          where: { clientId: input.clientId, agentId: input.agentId },
        });
        await tx.clientAgentAccessRequest.updateMany({
          where: { clientId: input.clientId, agentId: input.agentId, status: "approved" },
          data: { status: "revoked", decisionReason: input.reason, decidedAt: new Date() },
        });
        if (removed.count > 0 && input.pushEventId) {
          await enqueuePwaDeliveries(tx, input.clientId, {
            type: "access-revoked",
            eventId: input.pushEventId,
          });
        }
        return removed.count > 0;
      }),
    );
  }

  async rejectPendingAndConsumeToken(input: ClientAgentAccessRejectTxnInput): Promise<boolean> {
    return runPrismaTransactionWithRetry("client_agent_access_reject", () =>
      prismaClient.$transaction(async (tx) => {
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
      }),
    );
  }
}
