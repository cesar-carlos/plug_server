import type { IClientRegistrationRegisterTxn } from "../../domain/ports/client_registration_register_txn.port";
import type { IClientRegistrationApprovalTokenRepository } from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { IClientRegistrationPollTokenRepository } from "../../domain/repositories/client_registration_poll_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";

export class InMemoryClientRegistrationRegisterTxn implements IClientRegistrationRegisterTxn {
  constructor(
    private readonly clientRepository: IClientRepository,
    private readonly approvalTokenRepository: IClientRegistrationApprovalTokenRepository,
    private readonly pollTokenRepository: IClientRegistrationPollTokenRepository,
  ) {}

  async registerPending(
    input: Parameters<IClientRegistrationRegisterTxn["registerPending"]>[0],
  ): Promise<void> {
    await this.clientRepository.save(input.client);
    await this.approvalTokenRepository.save(input.approvalToken);
    await this.pollTokenRepository.save(input.pollToken);
  }
}
