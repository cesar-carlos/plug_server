import type { ClientAgentAccessRequest } from "../../domain/entities/client_agent_access_request.entity";
import type { Agent } from "../../domain/entities/agent.entity";
import type { Client } from "../../domain/entities/client.entity";
import type {
  ClientAgentAccessApprovalToken,
  ClientAgentAccessApprovalReviewSummaryRecord,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";

/**
 * Optional joins for {@link IClientAgentAccessApprovalTokenRepository.findReviewSummaryById}
 * in tests (mirrors Prisma behaviour). When omitted, `findReviewSummaryById` always returns `null`.
 */
export type InMemoryClientAgentAccessApprovalTokenReviewSummaryDeps = {
  readonly findRequestById: (id: string) => Promise<ClientAgentAccessRequest | null>;
  readonly findClientById: (id: string) => Promise<Client | null>;
  readonly findAgentById: (id: string) => Promise<Agent | null>;
};

export class InMemoryClientAgentAccessApprovalTokenRepository implements IClientAgentAccessApprovalTokenRepository {
  private readonly store = new Map<string, ClientAgentAccessApprovalToken>();
  private readonly tokenIdByRequestId = new Map<string, string>();

  constructor(private readonly reviewSummaryDeps?: InMemoryClientAgentAccessApprovalTokenReviewSummaryDeps) {}

  async save(token: ClientAgentAccessApprovalToken): Promise<void> {
    const existingTokenId = this.tokenIdByRequestId.get(token.requestId);
    if (existingTokenId) {
      this.store.delete(existingTokenId);
    }
    this.store.set(token.id, token);
    this.tokenIdByRequestId.set(token.requestId, token.id);
  }

  async findById(id: string): Promise<ClientAgentAccessApprovalToken | null> {
    return this.store.get(id) ?? null;
  }

  async findReviewSummaryById(id: string): Promise<ClientAgentAccessApprovalReviewSummaryRecord | null> {
    if (this.reviewSummaryDeps === undefined) {
      return null;
    }
    const token = this.store.get(id);
    if (!token) {
      return null;
    }
    const request = await this.reviewSummaryDeps.findRequestById(token.requestId);
    if (!request) {
      return null;
    }
    const client = await this.reviewSummaryDeps.findClientById(request.clientId);
    if (!client) {
      return null;
    }
    const agent = await this.reviewSummaryDeps.findAgentById(request.agentId);
    return {
      clientEmail: client.email,
      clientName: `${client.name} ${client.lastName}`.trim(),
      agentId: request.agentId,
      ...(agent !== null ? { agentName: agent.name } : {}),
      requestStatus: request.status,
      expiresAt: token.expiresAt,
    };
  }

  async deleteById(id: string): Promise<void> {
    const token = this.store.get(id);
    if (token) {
      this.tokenIdByRequestId.delete(token.requestId);
    }
    this.store.delete(id);
  }

  async deleteByRequestId(requestId: string): Promise<void> {
    const tokenId = this.tokenIdByRequestId.get(requestId);
    if (tokenId) {
      this.store.delete(tokenId);
    }
    this.tokenIdByRequestId.delete(requestId);
  }
}
