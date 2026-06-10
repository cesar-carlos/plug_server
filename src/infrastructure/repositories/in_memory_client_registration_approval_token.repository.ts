import type { Client } from "../../domain/entities/client.entity";
import type {
  ClientRegistrationApprovalToken,
  IClientRegistrationApprovalTokenRepository,
} from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";

export class InMemoryClientRegistrationApprovalTokenRepository implements IClientRegistrationApprovalTokenRepository {
  constructor(private readonly clientRepository?: IClientRepository) {}
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

  async replaceForClientRetry(
    client: Client,
    token: ClientRegistrationApprovalToken,
  ): Promise<void> {
    await this.save(token);
    if (this.clientRepository) {
      await this.clientRepository.save(client);
    }
  }

  async findById(id: string): Promise<ClientRegistrationApprovalToken | null> {
    return this.store.get(id) ?? null;
  }

  async findByClientId(clientId: string): Promise<ClientRegistrationApprovalToken | null> {
    const tokenId = this.tokenIdByClientId.get(clientId);
    return tokenId ? (this.store.get(tokenId) ?? null) : null;
  }

  async findReviewSummaryById(): Promise<null> {
    return null;
  }

  async deleteById(id: string): Promise<void> {
    const token = this.store.get(id);
    if (token) {
      this.tokenIdByClientId.delete(token.clientId);
    }
    this.store.delete(id);
  }
}
