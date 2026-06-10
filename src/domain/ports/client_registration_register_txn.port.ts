import type { Client } from "../entities/client.entity";
import type { ClientRegistrationApprovalToken } from "../repositories/client_registration_approval_token.repository.interface";
import type { ClientRegistrationPollToken } from "../repositories/client_registration_poll_token.repository.interface";

/**
 * Atomic persistence for a new pending client registration bundle:
 * client row + owner approval token + client poll token.
 */
export interface IClientRegistrationRegisterTxn {
  registerPending(input: {
    readonly client: Client;
    readonly approvalToken: ClientRegistrationApprovalToken;
    readonly pollToken: ClientRegistrationPollToken;
  }): Promise<void>;
}
