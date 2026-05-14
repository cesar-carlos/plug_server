import type {
  ClientRegistrationDecisionResult,
  IClientRegistrationDecisionTxn,
} from "../../domain/ports/client_registration_decision_txn.port";
import type { IClientRegistrationApprovalTokenRepository } from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import {
  transitionClientRegistrationToApproved,
  transitionClientRegistrationToRejected,
} from "../../domain/policies/client_registration_status.policy";
import { isExpired } from "../../shared/utils/date";

type ClientDecision = "approve" | "reject";

/**
 * Test/in-memory equivalent of the production transaction. The queue keeps
 * concurrent Promise.all decisions from observing the same token before it is
 * consumed.
 */
export class InMemoryClientRegistrationDecisionTxn implements IClientRegistrationDecisionTxn {
  private queue = Promise.resolve();

  constructor(
    private readonly tokenRepository: IClientRegistrationApprovalTokenRepository,
    private readonly clientRepository: IClientRepository,
  ) {}

  async approve(tokenId: string): Promise<ClientRegistrationDecisionResult> {
    return this.runExclusive(() => this.decide(tokenId, "approve"));
  }

  async reject(tokenId: string): Promise<ClientRegistrationDecisionResult> {
    return this.runExclusive(() => this.decide(tokenId, "reject"));
  }

  private async decide(
    tokenId: string,
    decision: ClientDecision,
  ): Promise<ClientRegistrationDecisionResult> {
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

    const transition =
      decision === "approve"
        ? transitionClientRegistrationToApproved(client)
        : transitionClientRegistrationToRejected(client);
    if (!transition.ok) {
      await this.tokenRepository.deleteById(tokenId);
      return { status: "not_pending" };
    }

    await this.clientRepository.save(transition.value);
    await this.tokenRepository.deleteById(tokenId);
    return decision === "approve"
      ? { status: "approved", client: transition.value }
      : { status: "rejected", client: transition.value };
  }

  private async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
