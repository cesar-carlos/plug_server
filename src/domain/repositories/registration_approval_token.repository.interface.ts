import type { RegistrationApprovalToken } from "../entities/registration_approval_token.entity";

export interface IRegistrationApprovalTokenRepository {
  save(token: RegistrationApprovalToken): Promise<void>;
  findById(id: string): Promise<RegistrationApprovalToken | null>;
  deleteById(id: string): Promise<void>;
}
