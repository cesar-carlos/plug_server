import type { User } from "../entities/user.entity";
import type { IRegistrationDecisionTxn } from "../ports/registration_decision_txn.port";
import { conflict, notFound, registrationTokenExpired } from "../../shared/errors/http_errors";
import {
  incrementRegistrationApproved,
  incrementRegistrationTokenExpired,
} from "../../shared/metrics/registration_flow.metrics";
import { type Result, ok, err } from "../../shared/errors/result";

export class ApproveRegistrationUseCase {
  constructor(private readonly registrationDecisionTxn: IRegistrationDecisionTxn) {}

  async execute(tokenId: string): Promise<Result<User>> {
    const result = await this.registrationDecisionTxn.approve(tokenId);
    if (result.status === "approved") {
      incrementRegistrationApproved();
      return ok(result.user);
    }
    if (result.status === "expired") {
      incrementRegistrationTokenExpired();
      return err(registrationTokenExpired("This approval link has expired"));
    }
    if (result.status === "user_not_found") {
      return err(notFound("User"));
    }
    if (result.status === "not_pending") {
      return err(conflict("Registration already processed"));
    }
    return err(notFound("Approval link is invalid or has expired"));
  }
}
