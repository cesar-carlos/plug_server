import { User } from "../entities/user.entity";
import type { IRegistrationApprovalTokenRepository } from "../repositories/registration_approval_token.repository.interface";
import type { IUserRepository } from "../repositories/user.repository.interface";
import { conflict, notFound, registrationTokenExpired } from "../../shared/errors/http_errors";
import {
  incrementRegistrationApproved,
  incrementRegistrationTokenExpired,
} from "../../shared/metrics/registration_flow.metrics";
import { type Result, ok, err } from "../../shared/errors/result";
import { isExpired } from "../../shared/utils/date";

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
      return err(notFound("User not found"));
    }

    if (user.status !== "pending") {
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(conflict("Registration already processed"));
    }

    const activeUser = new User({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      credentialsUpdatedAt: user.credentialsUpdatedAt,
      role: user.role,
      status: "active",
      createdAt: user.createdAt,
      ...(user.celular !== undefined ? { celular: user.celular } : {}),
    });

    await this.userRepository.save(activeUser);
    await this.approvalTokenRepository.deleteById(tokenId);

    incrementRegistrationApproved();
    return ok(activeUser);
  }
}
