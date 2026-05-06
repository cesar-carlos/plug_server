import { describe, expect, it } from "vitest";

import { Client } from "../../../../src/domain/entities/client.entity";
import {
  assertClientCanLogin,
  assertManagedClientStatusTransition,
  isClientRegistrationRetryEligible,
  reopenRejectedClientRegistration,
  transitionClientRegistrationToApproved,
  transitionClientRegistrationToRejected,
} from "../../../../src/domain/policies/client_registration_status.policy";

const makeClient = (status: "pending" | "active" | "rejected" | "blocked"): Client =>
  Client.create({
    id: `client-${status}`,
    userId: "owner-1",
    email: `${status}@test.com`,
    passwordHash: "hash",
    name: "Client",
    lastName: "Policy",
    status,
  });

describe("client_registration_status.policy", () => {
  it("approves pending registrations and rejects duplicate approvals", () => {
    const approved = transitionClientRegistrationToApproved(makeClient("pending"));
    expect(approved.ok).toBe(true);
    expect(approved.ok && approved.value.status).toBe("active");

    const duplicate = transitionClientRegistrationToApproved(makeClient("active"));
    expect(duplicate.ok).toBe(false);
  });

  it("marks pending registrations as rejected and only reopens rejected ones", () => {
    const rejected = transitionClientRegistrationToRejected(makeClient("pending"));
    expect(rejected.ok).toBe(true);
    expect(rejected.ok && rejected.value.status).toBe("rejected");

    const reopened = reopenRejectedClientRegistration(makeClient("rejected"));
    expect(reopened.ok).toBe(true);
    expect(reopened.ok && reopened.value.status).toBe("pending");

    const blocked = reopenRejectedClientRegistration(makeClient("blocked"));
    expect(blocked.ok).toBe(false);
  });

  it("limits login and managed status changes to allowed states", () => {
    expect(assertClientCanLogin("active").ok).toBe(true);
    expect(assertClientCanLogin("pending").ok).toBe(false);
    expect(assertClientCanLogin("rejected").ok).toBe(false);
    expect(assertClientCanLogin("blocked").ok).toBe(false);

    expect(assertManagedClientStatusTransition("active", "blocked").ok).toBe(true);
    expect(assertManagedClientStatusTransition("blocked", "active").ok).toBe(true);
    expect(assertManagedClientStatusTransition("pending", "active").ok).toBe(false);
    expect(assertManagedClientStatusTransition("rejected", "blocked").ok).toBe(false);
  });

  it("only allows retry for rejected registrations", () => {
    expect(isClientRegistrationRetryEligible("rejected")).toBe(true);
    expect(isClientRegistrationRetryEligible("pending")).toBe(false);
    expect(isClientRegistrationRetryEligible("active")).toBe(false);
    expect(isClientRegistrationRetryEligible("blocked")).toBe(false);
  });
});
