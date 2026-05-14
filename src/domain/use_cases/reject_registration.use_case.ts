import type { User } from "../entities/user.entity";
import type { IRegistrationDecisionTxn } from "../ports/registration_decision_txn.port";
import { conflict, notFound, registrationTokenExpired } from "../../shared/errors/http_errors";
import {
  incrementRegistrationRejected,
  incrementRegistrationTokenExpired,
} from "../../shared/metrics/registration_flow.metrics";
import { type Result, ok, err } from "../../shared/errors/result";

export class RejectRegistrationUseCase {
  constructor(private readonly registrationDecisionTxn: IRegistrationDecisionTxn) {}

  async execute(tokenId: string): Promise<Result<User>> {
    const result = await this.registrationDecisionTxn.reject(tokenId);
    if (result.status === "rejected") {
      incrementRegistrationRejected();
      return ok(result.user);
    }
    if (result.status === "expired") {
      incrementRegistrationTokenExpired();
      return err(registrationTokenExpired("This rejection link has expired"));
    }
    if (result.status === "user_not_found") {
      return err(notFound("User"));
    }
    if (result.status === "not_pending") {
      return err(conflict("Registration already processed"));
    }
    return err(notFound("Rejection link is invalid or has expired"));
  }
}
