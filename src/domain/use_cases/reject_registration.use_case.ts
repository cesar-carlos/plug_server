import { User } from "../entities/user.entity";
import type { IRegistrationApprovalTokenRepository } from "../repositories/registration_approval_token.repository.interface";
import type { IUserRepository } from "../repositories/user.repository.interface";
import { conflict, notFound, registrationTokenExpired } from "../../shared/errors/http_errors";
import { incrementRegistrationRejected, incrementRegistrationTokenExpired } from "../../shared/metrics/registration_flow.metrics";
import { type Result, ok, err } from "../../shared/errors/result";
import { isExpired } from "../../shared/utils/date";

export class RejectRegistrationUseCase {
  constructor(
    private readonly approvalTokenRepository: IRegistrationApprovalTokenRepository,
    private readonly userRepository: IUserRepository,
  ) {}

  async execute(tokenId: string): Promise<Result<User>> {
    const token = await this.approvalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Rejection link is invalid or has expired"));
    }

    if (isExpired(token.expiresAt)) {
      await this.approvalTokenRepository.deleteById(tokenId);
      incrementRegistrationTokenExpired();
      return err(registrationTokenExpired("This rejection link has expired"));
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

    const rejectedUser = new User({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      role: user.role,
      status: "rejected",
      createdAt: user.createdAt,
    });

    await this.userRepository.save(rejectedUser);
    await this.approvalTokenRepository.deleteById(tokenId);

    incrementRegistrationRejected();
    return ok(rejectedUser);
  }
}
