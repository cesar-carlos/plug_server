import type { IRegistrationApprovalTokenRepository } from "../repositories/registration_approval_token.repository.interface";
import { notFound } from "../../shared/errors/http_errors";
import { incrementRegistrationTokenExpired } from "../../shared/metrics/registration_flow.metrics";
import { type Result, ok, err } from "../../shared/errors/result";
import { isExpired } from "../../shared/utils/date";

export type RegistrationStatusPayload =
  | { readonly status: "pending" }
  | { readonly status: "expired" };

export class GetRegistrationStatusUseCase {
  constructor(private readonly approvalTokenRepository: IRegistrationApprovalTokenRepository) {}

  async execute(tokenId: string): Promise<Result<RegistrationStatusPayload>> {
    const token = await this.approvalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Registration token is invalid or was already used"));
    }

    if (isExpired(token.expiresAt)) {
      incrementRegistrationTokenExpired();
      return ok({ status: "expired" });
    }

    return ok({ status: "pending" });
  }
}
