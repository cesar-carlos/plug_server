import type {
  ClientAgentAccessApprovalToken,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";

export class InMemoryClientAgentAccessApprovalTokenRepository
  implements IClientAgentAccessApprovalTokenRepository
{
  private readonly store = new Map<string, ClientAgentAccessApprovalToken>();

  async save(token: ClientAgentAccessApprovalToken): Promise<void> {
    this.store.set(token.id, token);
  }

  async findById(id: string): Promise<ClientAgentAccessApprovalToken | null> {
    return this.store.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    this.store.delete(id);
  }
}
