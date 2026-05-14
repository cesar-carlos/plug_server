import type {
  IRegistrationDecisionTxn,
  RegistrationDecisionResult,
} from "../../domain/ports/registration_decision_txn.port";
import type { IRegistrationApprovalTokenRepository } from "../../domain/repositories/registration_approval_token.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import {
  transitionUserRegistrationToApproved,
  transitionUserRegistrationToRejected,
} from "../../domain/policies/user_registration_status.policy";
import { isExpired } from "../../shared/utils/date";

type UserDecision = "approve" | "reject";

/**
 * Test/in-memory equivalent of the production transaction. The queue keeps
 * concurrent Promise.all decisions from observing the same token before it is
 * consumed.
 */
export class InMemoryRegistrationDecisionTxn implements IRegistrationDecisionTxn {
  private queue = Promise.resolve();

  constructor(
    private readonly tokenRepository: IRegistrationApprovalTokenRepository,
    private readonly userRepository: IUserRepository,
  ) {}

  async approve(tokenId: string): Promise<RegistrationDecisionResult> {
    return this.runExclusive(() => this.decide(tokenId, "approve"));
  }

  async reject(tokenId: string): Promise<RegistrationDecisionResult> {
    return this.runExclusive(() => this.decide(tokenId, "reject"));
  }

  private async decide(
    tokenId: string,
    decision: UserDecision,
  ): Promise<RegistrationDecisionResult> {
    const token = await this.tokenRepository.findById(tokenId);
    if (!token) {
      return { status: "not_found" };
    }

    if (isExpired(token.expiresAt)) {
      await this.tokenRepository.deleteById(tokenId);
      return { status: "expired" };
    }

    const user = await this.userRepository.findById(token.userId);
    if (!user) {
      await this.tokenRepository.deleteById(tokenId);
      return { status: "user_not_found" };
    }

    const transition =
      decision === "approve"
        ? transitionUserRegistrationToApproved(user)
        : transitionUserRegistrationToRejected(user);
    if (!transition.ok) {
      await this.tokenRepository.deleteById(tokenId);
      return { status: "not_pending" };
    }

    await this.userRepository.save(transition.value);
    await this.tokenRepository.deleteById(tokenId);
    return decision === "approve"
      ? { status: "approved", user: transition.value }
      : { status: "rejected", user: transition.value };
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
