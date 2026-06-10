import type {
  ClientRegistrationDecisionResult,
  IClientRegistrationDecisionTxn,
} from "../../domain/ports/client_registration_decision_txn.port";
import type { IClientRegistrationApprovalTokenRepository } from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
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
    private readonly userRepository: IUserRepository,
  ) {}

  async approve(tokenId: string): Promise<ClientRegistrationDecisionResult> {
    return this.runExclusive(() => this.decideByToken(tokenId, "approve"));
  }

  async reject(tokenId: string): Promise<ClientRegistrationDecisionResult> {
    return this.runExclusive(() => this.decideByToken(tokenId, "reject"));
  }

  async approveByClientId(clientId: string): Promise<ClientRegistrationDecisionResult> {
    return this.runExclusive(() => this.decideByClientId(clientId, "approve"));
  }

  async rejectByClientId(clientId: string): Promise<ClientRegistrationDecisionResult> {
    return this.runExclusive(() => this.decideByClientId(clientId, "reject"));
  }

  private async decideByToken(
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

    return this.transitionClient(token.clientId, tokenId, decision);
  }

  private async decideByClientId(
    clientId: string,
    decision: ClientDecision,
  ): Promise<ClientRegistrationDecisionResult> {
    const token = await this.tokenRepository.findByClientId(clientId);
    return this.transitionClient(clientId, token?.id, decision);
  }

  private async transitionClient(
    clientId: string,
    approvalTokenId: string | undefined,
    decision: ClientDecision,
  ): Promise<ClientRegistrationDecisionResult> {
    const client = await this.clientRepository.findById(clientId);
    if (!client) {
      if (approvalTokenId) {
        await this.tokenRepository.deleteById(approvalTokenId);
      }
      return { status: "client_not_found" };
    }

    const owner = await this.userRepository.findById(client.userId);
    if (!owner || owner.status !== "active") {
      return { status: "owner_inactive" };
    }

    const transition =
      decision === "approve"
        ? transitionClientRegistrationToApproved(client)
        : transitionClientRegistrationToRejected(client);
    if (!transition.ok) {
      if (approvalTokenId) {
        await this.tokenRepository.deleteById(approvalTokenId);
      }
      return { status: "not_pending" };
    }

    await this.clientRepository.save(transition.value);
    const token = await this.tokenRepository.findByClientId(clientId);
    if (token) {
      await this.tokenRepository.deleteById(token.id);
    }
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
