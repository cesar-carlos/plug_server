import { ClientAgentAccessRequest } from "../../domain/entities/client_agent_access_request.entity";
import type {
  ClientAgentAccessApproveTxnInput,
  ClientAgentAccessRejectTxnInput,
  IClientAgentAccessApprovalTxn,
} from "../../domain/ports/client_agent_access_approval_txn.port";
import type { InMemoryClientAgentAccessApprovalTokenRepository } from "../repositories/in_memory_client_agent_access_approval_token.repository";
import type { InMemoryClientAgentAccessRepository } from "../repositories/in_memory_client_agent_access.repository";
import type { InMemoryClientAgentAccessRequestRepository } from "../repositories/in_memory_client_agent_access_request.repository";

/**
 * Best-effort atomicity for unit tests (single-threaded); production uses
 * {@link PrismaClientAgentAccessApprovalTxn}.
 */
export class InMemoryClientAgentAccessApprovalTxn implements IClientAgentAccessApprovalTxn {
  constructor(
    private readonly requestRepository: InMemoryClientAgentAccessRequestRepository,
    private readonly accessRepository: InMemoryClientAgentAccessRepository,
    private readonly tokenRepository: InMemoryClientAgentAccessApprovalTokenRepository,
  ) {}

  async approvePendingAndGrantAccess(input: ClientAgentAccessApproveTxnInput): Promise<boolean> {
    const existing = await this.requestRepository.findById(input.requestId);
    if (!existing || existing.status !== "pending") {
      return false;
    }

    await this.requestRepository.save(
      new ClientAgentAccessRequest({
        id: existing.id,
        clientId: existing.clientId,
        agentId: existing.agentId,
        status: "approved",
        requestedAt: existing.requestedAt,
        decidedAt: input.approvedAt,
        retryCount: existing.retryCount,
        createdAt: existing.createdAt,
        updatedAt: new Date(),
      }),
    );
    await this.accessRepository.addAccess(input.clientId, input.agentId, input.approvedAt);

    if (input.consumeTokenId !== undefined) {
      await this.tokenRepository.deleteById(input.consumeTokenId);
    } else {
      await this.tokenRepository.deleteByRequestId(input.requestId);
    }

    return true;
  }

  async rejectPendingAndConsumeToken(input: ClientAgentAccessRejectTxnInput): Promise<boolean> {
    const existing = await this.requestRepository.findById(input.requestId);
    if (!existing || existing.status !== "pending") {
      return false;
    }

    await this.requestRepository.setStatus(input.requestId, "rejected", {
      decidedAt: input.decidedAt,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    if (input.consumeTokenId !== undefined) {
      await this.tokenRepository.deleteById(input.consumeTokenId);
    } else {
      await this.tokenRepository.deleteByRequestId(input.requestId);
    }

    return true;
  }
}
