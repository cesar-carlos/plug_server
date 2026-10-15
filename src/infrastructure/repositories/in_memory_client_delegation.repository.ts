import type {
  ClientDelegation,
  IClientDelegationRepository,
} from "../../domain/ports/client_delegation.port";
export class InMemoryClientDelegationRepository implements IClientDelegationRepository {
  private readonly values = new Map<string, ClientDelegation>();
  async create(value: ClientDelegation): Promise<void> {
    this.values.set(value.tokenHash, structuredClone(value));
  }
  async findByHash(hash: string): Promise<ClientDelegation | null> {
    return structuredClone(this.values.get(hash) ?? null);
  }
  async revoke(id: string, clientId: string, now: Date): Promise<boolean> {
    const value = [...this.values.values()].find((v) => v.id === id && v.clientId === clientId);
    if (!value) return false;
    this.values.set(value.tokenHash, { ...value, revokedAt: value.revokedAt ?? now });
    return true;
  }
}
