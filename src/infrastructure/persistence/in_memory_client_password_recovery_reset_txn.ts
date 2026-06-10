import type {
  ClientPasswordRecoveryResetResult,
  IClientPasswordRecoveryResetTxn,
} from "../../domain/ports/client_password_recovery_reset_txn.port";
import type { IClientPasswordRecoveryTokenRepository } from "../../domain/repositories/client_password_recovery_token.repository.interface";
import type { IClientRefreshTokenRepository } from "../../domain/repositories/client_refresh_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import { buildClientWithRotatedCredentials } from "../../shared/utils/client_credential_rotation";
import { isExpired } from "../../shared/utils/date";

/**
 * Test/in-memory equivalent of the production reset transaction. The queue
 * keeps concurrent resets from observing the same token before it is consumed.
 */
export class InMemoryClientPasswordRecoveryResetTxn implements IClientPasswordRecoveryResetTxn {
  private queue = Promise.resolve();

  constructor(
    private readonly tokenRepository: IClientPasswordRecoveryTokenRepository,
    private readonly clientRepository: IClientRepository,
    private readonly clientRefreshTokenRepository: IClientRefreshTokenRepository,
  ) {}

  async resetByToken(
    tokenId: string,
    passwordHash: string,
  ): Promise<ClientPasswordRecoveryResetResult> {
    return this.runExclusive(() => this.reset(tokenId, passwordHash));
  }

  private async reset(
    tokenId: string,
    passwordHash: string,
  ): Promise<ClientPasswordRecoveryResetResult> {
    const token = await this.tokenRepository.findById(tokenId);
    if (!token) {
      return { status: "not_found" };
    }

    if (isExpired(token.expiresAt)) {
      await this.tokenRepository.deleteById(tokenId);
      return { status: "expired" };
    }

    const client = await this.clientRepository.findById(token.clientId);
    if (!client) {
      await this.tokenRepository.deleteById(tokenId);
      return { status: "client_not_found" };
    }

    if (client.status !== "active") {
      await this.tokenRepository.deleteById(tokenId);
      return { status: "client_inactive" };
    }

    const updated = buildClientWithRotatedCredentials(client, passwordHash);
    await this.clientRepository.save(updated);
    await this.tokenRepository.deleteById(tokenId);
    await this.clientRefreshTokenRepository.revokeAllForClient(client.id);
    return { status: "success" };
  }

  private runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
