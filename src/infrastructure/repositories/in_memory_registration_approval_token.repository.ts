import type { RegistrationApprovalToken } from "../../domain/entities/registration_approval_token.entity";
import type { IRegistrationApprovalTokenRepository } from "../../domain/repositories/registration_approval_token.repository.interface";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";

export class InMemoryRegistrationApprovalTokenRepository implements IRegistrationApprovalTokenRepository {
  private readonly byId = new Map<string, RegistrationApprovalToken>();

  async save(token: RegistrationApprovalToken): Promise<void> {
    this.byId.set(hashRegistrationToken(token.id), token);
  }

  async findById(id: string): Promise<RegistrationApprovalToken | null> {
    return this.byId.get(hashRegistrationToken(id)) ?? this.byId.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    this.byId.delete(hashRegistrationToken(id));
    this.byId.delete(id);
  }

  clear(): void {
    this.byId.clear();
  }
}
