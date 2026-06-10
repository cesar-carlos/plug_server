import type { Client, ClientStatus } from "../entities/client.entity";
import { badRequest, conflict, forbidden } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";

export type ManagedClientStatus = Extract<ClientStatus, "active" | "blocked">;

const withStatus = (client: Client, status: ClientStatus): Client =>
  client.withStatus(status, { updatedAt: new Date() });

export const transitionClientRegistrationToApproved = (client: Client): Result<Client> => {
  if (client.status !== "pending") {
    return err(conflict("Client registration already processed"));
  }
  return ok(withStatus(client, "active"));
};

export const transitionClientRegistrationToRejected = (client: Client): Result<Client> => {
  if (client.status !== "pending") {
    return err(conflict("Client registration already processed"));
  }
  return ok(withStatus(client, "rejected"));
};

export const reopenRejectedClientRegistration = (client: Client): Result<Client> => {
  if (client.status !== "rejected") {
    return err(conflict("Client registration cannot be retried from its current status"));
  }
  return ok(withStatus(client, "pending"));
};

export const assertClientCanLogin = (status: ClientStatus): Result<void> => {
  if (status === "blocked") {
    return err(forbidden("Client account is blocked"));
  }
  if (status !== "active") {
    return err(forbidden("Client account is pending approval"));
  }
  return ok(undefined);
};

export const assertClientEligibleForAccessGrant = (client: Client): Result<void> => {
  if (client.status !== "active") {
    return err(forbidden("Client account cannot receive access approval in its current state"));
  }
  return ok(undefined);
};

export const assertManagedClientStatusTransition = (
  current: ClientStatus,
  next: ManagedClientStatus,
): Result<void> => {
  if (current === "pending" || current === "rejected") {
    return err(
      conflict(
        "Pending or rejected client registrations must be approved or retried via the registration flow",
      ),
    );
  }
  if (next !== "active" && next !== "blocked") {
    return err(badRequest("Managed client status must be active or blocked"));
  }
  return ok(undefined);
};

/** Pending registrations with an expired owner-approval link may resend via retry. */
export const isClientRegistrationResendEligible = (
  status: ClientStatus,
  approvalTokenExpired: boolean,
): boolean => status === "rejected" || (status === "pending" && approvalTokenExpired);
