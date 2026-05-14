import type { User } from "../entities/user.entity";

export type RegistrationDecisionResult =
  | { readonly status: "approved"; readonly user: User }
  | { readonly status: "rejected"; readonly user: User }
  | { readonly status: "expired" }
  | { readonly status: "not_found" }
  | { readonly status: "user_not_found" }
  | { readonly status: "not_pending" };

/**
 * Atomic user registration decision. Implementations must validate the token,
 * check expiry, change a pending user status, and consume the token in one
 * critical section so concurrent approve/reject attempts have a single winner.
 */
export interface IRegistrationDecisionTxn {
  approve(tokenId: string): Promise<RegistrationDecisionResult>;
  reject(tokenId: string): Promise<RegistrationDecisionResult>;
}
