import type {
  ClientRegistrationApprovalToken,
  IClientRegistrationApprovalTokenRepository,
} from "../../domain/repositories/client_registration_approval_token.repository.interface";

export class InMemoryClientRegistrationApprovalTokenRepository
  implements IClientRegistrationApprovalTokenRepository
{
  private readonly store = new Map<string, ClientRegistrationApprovalToken>();
  private readonly tokenIdByClientId = new Map<string, string>();

  async save(token: ClientRegistrationApprovalToken): Promise<void> {
    const existingTokenId = this.tokenIdByClientId.get(token.clientId);
    if (existingTokenId) {
      this.store.delete(existingTokenId);
    }
    this.store.set(token.id, token);
    this.tokenIdByClientId.set(token.clientId, token.id);
  }

  async findById(id: string): Promise<ClientRegistrationApprovalToken | null> {
    return this.store.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    const token = this.store.get(id);
    if (token) {
      this.tokenIdByClientId.delete(token.clientId);
    }
    this.store.delete(id);
  }
}
