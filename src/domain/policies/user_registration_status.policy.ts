import type { User, UserStatus } from "../entities/user.entity";
import { conflict } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";

const withStatus = (user: User, status: UserStatus): User =>
  user.withStatus(status, {
    createdAt: user.createdAt,
    credentialsUpdatedAt: user.credentialsUpdatedAt,
  });

export const transitionUserRegistrationToApproved = (user: User): Result<User> => {
  if (user.status !== "pending") {
    return err(conflict("Registration already processed"));
  }
  return ok(withStatus(user, "active"));
};

export const transitionUserRegistrationToRejected = (user: User): Result<User> => {
  if (user.status !== "pending") {
    return err(conflict("Registration already processed"));
  }
  return ok(withStatus(user, "rejected"));
};

export const reopenRejectedUserRegistration = (user: User): Result<User> => {
  if (user.status !== "rejected") {
    return err(conflict("Registration cannot be retried from its current status"));
  }
  return ok(withStatus(user, "pending"));
};
