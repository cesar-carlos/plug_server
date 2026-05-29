import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(async () => undefined),
}));

import { Agent } from "../../../../src/domain/entities/agent.entity";
import { Client } from "../../../../src/domain/entities/client.entity";
import { User } from "../../../../src/domain/entities/user.entity";
import {
  CLIENT_TOKEN_AUDIT_EVENT_TYPE_CLEARED,
  CLIENT_TOKEN_AUDIT_EVENT_TYPE_SET,
} from "../../../../src/application/services/client_agent_access_types";
import { ClientAgentTokenService } from "../../../../src/application/services/client_agent_token.service";
import { recordSocketAuditEvent } from "../../../../src/application/services/socket_audit.service";
import { InMemoryAgentIdentityRepository } from "../../../../src/infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryAgentRepository } from "../../../../src/infrastructure/repositories/in_memory_agent.repository";
import { InMemoryClientAgentAccessRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access.repository";
import { InMemoryClientRepository } from "../../../../src/infrastructure/repositories/in_memory_client.repository";
import { InMemoryUserRepository } from "../../../../src/infrastructure/repositories/in_memory_user.repository";

const mockedAudit = vi.mocked(recordSocketAuditEvent);

const ownerUserId = "1f1c0bdc-7c41-4f86-9a4f-2d73d4d50e21";
const clientId = "f1f6db4c-a1a3-4f1d-a8a2-1b4c0f4f0001";
const agentId = "8f5cad11-0fe5-4d11-9e6f-22f02b9a2002";

let userRepository: InMemoryUserRepository;
let clientRepository: InMemoryClientRepository;
let agentRepository: InMemoryAgentRepository;
let identityRepository: InMemoryAgentIdentityRepository;
let accessRepository: InMemoryClientAgentAccessRepository;
let service: ClientAgentTokenService;

const buildService = (): ClientAgentTokenService =>
  new ClientAgentTokenService(accessRepository);

const seedApprovedAccess = async (): Promise<void> => {
  await userRepository.save(
    User.create({
      id: ownerUserId,
      email: "owner@example.com",
      passwordHash: "hash",
      role: "user",
      status: "active",
    }),
  );
  await clientRepository.save(
    Client.create({
      id: clientId,
      userId: ownerUserId,
      email: "client@example.com",
      passwordHash: "hash",
      name: "Client",
      lastName: "Token",
      status: "active",
    }),
  );
  await agentRepository.save(Agent.create({ agentId, name: "Agent A" }));
  await identityRepository.bindIfUnbound(agentId, ownerUserId);
  await accessRepository.addAccess(clientId, agentId, new Date());
};

describe("ClientAgentAccessService client_token audit", () => {
  beforeEach(async () => {
    mockedAudit.mockClear();
    userRepository = new InMemoryUserRepository();
    clientRepository = new InMemoryClientRepository();
    agentRepository = new InMemoryAgentRepository();
    identityRepository = new InMemoryAgentIdentityRepository();
    accessRepository = new InMemoryClientAgentAccessRepository();
    service = buildService();
    await seedApprovedAccess();
  });

  it("emits client_token.set audit with len + replacedExisting=false on first write", async () => {
    const result = await service.setClientTokenForAgent(
      clientId,
      agentId,
      "secret-token-value-123",
    );
    expect(result.ok).toBe(true);

    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const call = mockedAudit.mock.calls[0]?.[0];
    expect(call?.eventType).toBe(CLIENT_TOKEN_AUDIT_EVENT_TYPE_SET);
    expect(call?.actorUserId).toBe(clientId);
    expect(call?.actorRole).toBe("client");
    expect(call?.direction).toBe("control");
    expect(call?.agentId).toBe(agentId);
    expect(call?.payload).toEqual({
      len: "secret-token-value-123".length,
      replacedExisting: false,
    });

    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain("secret-token-value-123");
  });

  it("emits client_token.set with replacedExisting=true when overwriting", async () => {
    await service.setClientTokenForAgent(clientId, agentId, "first");
    mockedAudit.mockClear();
    const result = await service.setClientTokenForAgent(clientId, agentId, "second-value");
    expect(result.ok).toBe(true);

    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const call = mockedAudit.mock.calls[0]?.[0];
    expect(call?.eventType).toBe(CLIENT_TOKEN_AUDIT_EVENT_TYPE_SET);
    expect(call?.payload).toEqual({ len: "second-value".length, replacedExisting: true });
    expect(JSON.stringify(call)).not.toContain("second-value");
    expect(JSON.stringify(call)).not.toContain("first");
  });

  it("emits client_token.cleared with len=0 when clearing an existing token", async () => {
    await service.setClientTokenForAgent(clientId, agentId, "to-be-cleared");
    mockedAudit.mockClear();

    const result = await service.setClientTokenForAgent(clientId, agentId, null);
    expect(result.ok).toBe(true);

    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const call = mockedAudit.mock.calls[0]?.[0];
    expect(call?.eventType).toBe(CLIENT_TOKEN_AUDIT_EVENT_TYPE_CLEARED);
    expect(call?.payload).toEqual({ len: 0, replacedExisting: true });
  });

  it("emits client_token.cleared with replacedExisting=false when there was no token before", async () => {
    const result = await service.setClientTokenForAgent(clientId, agentId, null);
    expect(result.ok).toBe(true);

    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const call = mockedAudit.mock.calls[0]?.[0];
    expect(call?.eventType).toBe(CLIENT_TOKEN_AUDIT_EVENT_TYPE_CLEARED);
    expect(call?.payload).toEqual({ len: 0, replacedExisting: false });
  });

  it("does NOT emit audit when the client has no approved access (403)", async () => {
    await accessRepository.removeAccess(clientId, agentId);

    const result = await service.setClientTokenForAgent(clientId, agentId, "anything");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AGENT_ACCESS_DENIED");
    }
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("never includes the token value in any field of the audit input", async () => {
    const tokenValue = "ct-secret-marker-XYZABC123";
    await service.setClientTokenForAgent(clientId, agentId, tokenValue);

    for (const call of mockedAudit.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(tokenValue);
    }
  });
});
