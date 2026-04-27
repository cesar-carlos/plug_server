import type { RegistrationApprovalToken } from "../entities/registration_approval_token.entity";
import type { User, UserStatus } from "../entities/user.entity";

export interface RegistrationApprovalReviewSummaryRecord {
  readonly email: string;
  readonly status: UserStatus;
  readonly expiresAt: Date;
}

export interface IRegistrationApprovalTokenRepository {
  save(token: RegistrationApprovalToken): Promise<void>;
  replaceForUserRetry(user: User, token: RegistrationApprovalToken): Promise<void>;
  findById(id: string): Promise<RegistrationApprovalToken | null>;
  findReviewSummaryById(id: string): Promise<RegistrationApprovalReviewSummaryRecord | null>;
  deleteById(id: string): Promise<void>;
  deleteByUserId(userId: string): Promise<void>;
}
