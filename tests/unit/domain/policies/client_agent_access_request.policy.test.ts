import { describe, expect, it } from "vitest";

import { Agent } from "../../../../src/domain/entities/agent.entity";
import { Client } from "../../../../src/domain/entities/client.entity";
import {
  assertAgentEligibleForClientAccessGrant,
  assertClientEligibleForClientAccessGrant,
  isClientAccessRequestRetryEligible,
} from "../../../../src/domain/policies/client_agent_access_request.policy";

describe("client_agent_access_request.policy", () => {
  it("requires active client and agent for access grant", () => {
    const client = Client.create({
      id: "client-active",
      userId: "owner-1",
      email: "client@test.com",
      passwordHash: "hash",
      name: "Client",
      lastName: "Policy",
      status: "active",
    });
    const rejectedClient = client.withStatus("rejected");
    const activeAgent = Agent.create({
      name: "Active Agent",
      cnpjCpf: "client-agent-policy-active",
      email: "agent@test.com",
      status: "active",
    });
    const inactiveAgent = activeAgent.deactivate();

    expect(assertClientEligibleForClientAccessGrant(client).ok).toBe(true);
    expect(assertClientEligibleForClientAccessGrant(rejectedClient).ok).toBe(false);
    expect(assertAgentEligibleForClientAccessGrant(activeAgent).ok).toBe(true);
    expect(assertAgentEligibleForClientAccessGrant(inactiveAgent).ok).toBe(false);
  });

  it("allows retry only for terminal request states", () => {
    expect(isClientAccessRequestRetryEligible("rejected")).toBe(true);
    expect(isClientAccessRequestRetryEligible("expired")).toBe(true);
    expect(isClientAccessRequestRetryEligible("revoked")).toBe(true);
    expect(isClientAccessRequestRetryEligible("pending")).toBe(false);
    expect(isClientAccessRequestRetryEligible("approved")).toBe(false);
  });
});
