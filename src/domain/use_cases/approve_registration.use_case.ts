import type { User } from "../entities/user.entity";
import type { IRegistrationApprovalTokenRepository } from "../repositories/registration_approval_token.repository.interface";
import type { IUserRepository } from "../repositories/user.repository.interface";
import { conflict, notFound, registrationTokenExpired } from "../../shared/errors/http_errors";
import {
  incrementRegistrationApproved,
  incrementRegistrationTokenExpired,
} from "../../shared/metrics/registration_flow.metrics";
import { type Result, ok, err } from "../../shared/errors/result";
import { isExpired } from "../../shared/utils/date";
import { transitionUserRegistrationToApproved } from "../policies/user_registration_status.policy";

export class ApproveRegistrationUseCase {
  constructor(
    private readonly approvalTokenRepository: IRegistrationApprovalTokenRepository,
    private readonly userRepository: IUserRepository,
  ) {}

  async execute(tokenId: string): Promise<Result<User>> {
    const token = await this.approvalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Approval link is invalid or has expired"));
    }

    if (isExpired(token.expiresAt)) {
      await this.approvalTokenRepository.deleteById(tokenId);
      incrementRegistrationTokenExpired();
      return err(registrationTokenExpired("This approval link has expired"));
    }

    const user = await this.userRepository.findById(token.userId);
    if (!user) {
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(notFound("User"));
    }

    const activeUserResult = transitionUserRegistrationToApproved(user);
    if (!activeUserResult.ok) {
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(conflict(activeUserResult.error.message));
    }
    const activeUser = activeUserResult.value;

    await this.userRepository.save(activeUser);
    await this.approvalTokenRepository.deleteById(tokenId);

    incrementRegistrationApproved();
    return ok(activeUser);
  }
}
