import { describe, expect, it } from "vitest";

import { User } from "../../../../src/domain/entities/user.entity";
import {
  reopenRejectedUserRegistration,
  transitionUserRegistrationToApproved,
  transitionUserRegistrationToRejected,
} from "../../../../src/domain/policies/user_registration_status.policy";

const makeUser = (status: "pending" | "active" | "rejected" | "blocked"): User =>
  User.create({
    id: `user-${status}`,
    email: `${status}@test.com`,
    passwordHash: "hash",
    role: "user",
    status,
  });

describe("user_registration_status.policy", () => {
  it("approves and rejects only pending registrations", () => {
    const approved = transitionUserRegistrationToApproved(makeUser("pending"));
    expect(approved.ok).toBe(true);
    expect(approved.ok && approved.value.status).toBe("active");

    const rejected = transitionUserRegistrationToRejected(makeUser("pending"));
    expect(rejected.ok).toBe(true);
    expect(rejected.ok && rejected.value.status).toBe("rejected");

    expect(transitionUserRegistrationToApproved(makeUser("active")).ok).toBe(false);
    expect(transitionUserRegistrationToRejected(makeUser("blocked")).ok).toBe(false);
  });

  it("reopens only rejected registrations", () => {
    const reopened = reopenRejectedUserRegistration(makeUser("rejected"));
    expect(reopened.ok).toBe(true);
    expect(reopened.ok && reopened.value.status).toBe("pending");

    expect(reopenRejectedUserRegistration(makeUser("pending")).ok).toBe(false);
  });
});
