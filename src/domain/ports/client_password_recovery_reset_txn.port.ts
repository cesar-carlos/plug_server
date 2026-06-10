export type ClientPasswordRecoveryResetResult =
  | { readonly status: "success" }
  | { readonly status: "expired" }
  | { readonly status: "not_found" }
  | { readonly status: "client_not_found" }
  | { readonly status: "client_inactive" };

/**
 * Atomic password recovery reset. Implementations must lock the recovery token,
 * validate expiry and client status, update the password, consume the token, and
 * revoke refresh sessions in one critical section.
 */
export interface IClientPasswordRecoveryResetTxn {
  resetByToken(tokenId: string, passwordHash: string): Promise<ClientPasswordRecoveryResetResult>;
}
