import type { Client } from "../entities/client.entity";

export type ClientRegistrationDecisionResult =
  | { readonly status: "approved"; readonly client: Client }
  | { readonly status: "rejected"; readonly client: Client }
  | { readonly status: "expired" }
  | { readonly status: "not_found" }
  | { readonly status: "client_not_found" }
  | { readonly status: "not_pending" }
  | { readonly status: "owner_inactive" };

/**
 * Atomic client registration decision. Implementations must validate the token,
 * check expiry, verify the owner is still active, change a pending client status,
 * and consume the approval token in one critical section so concurrent
 * approve/reject attempts have a single winner.
 */
export interface IClientRegistrationDecisionTxn {
  approve(tokenId: string): Promise<ClientRegistrationDecisionResult>;
  reject(tokenId: string): Promise<ClientRegistrationDecisionResult>;
  approveByClientId(clientId: string): Promise<ClientRegistrationDecisionResult>;
  rejectByClientId(clientId: string): Promise<ClientRegistrationDecisionResult>;
}
