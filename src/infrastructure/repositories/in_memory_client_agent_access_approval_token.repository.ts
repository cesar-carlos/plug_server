import type {
  ClientAgentAccessApprovalToken,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";

export class InMemoryClientAgentAccessApprovalTokenRepository implements IClientAgentAccessApprovalTokenRepository {
  private readonly store = new Map<string, ClientAgentAccessApprovalToken>();
  private readonly tokenIdByRequestId = new Map<string, string>();

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

  async findReviewSummaryById(): Promise<null> {
    return null;
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
