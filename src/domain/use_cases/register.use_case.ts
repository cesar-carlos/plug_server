import { RegistrationApprovalToken } from "../entities/registration_approval_token.entity";
import { User, type UserRole } from "../entities/user.entity";
import type { IRegistrationApprovalTokenRepository } from "../repositories/registration_approval_token.repository.interface";
import type { IUserRepository } from "../repositories/user.repository.interface";
import { conflict } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export interface RegisterInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly role?: UserRole;
  readonly approvalTokenExpiresAt: Date;
  /** Opaque high-entropy id (generated outside the domain, e.g. `generateOpaqueRegistrationToken`). */
  readonly approvalTokenId: string;
}

export interface RegisterOutput {
  readonly user: User;
  readonly approvalToken: RegistrationApprovalToken;
}

export class RegisterUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly approvalTokenRepository: IRegistrationApprovalTokenRepository,
  ) {}

  async execute(input: RegisterInput): Promise<Result<RegisterOutput>> {
    const existing = await this.userRepository.findByEmail(input.email);
    if (existing) {
      return err(conflict("Email already in use"));
    }

    const user = User.create({
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role ?? "user",
      status: "pending",
    });

    await this.userRepository.save(user);

    const approvalToken = RegistrationApprovalToken.create({
      id: input.approvalTokenId,
      userId: user.id,
      expiresAt: input.approvalTokenExpiresAt,
    });

    await this.approvalTokenRepository.save(approvalToken);

    return ok({ user, approvalToken });
  }
}
