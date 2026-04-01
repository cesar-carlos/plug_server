import { describe, expect, it, vi } from "vitest";

import { UserAgentService } from "../../../../src/application/services/user_agent.service";
import { Agent } from "../../../../src/domain/entities/agent.entity";

describe("UserAgentService.addSelfAgentIds", () => {
  it("returns AGENT_NOT_ONLINE_FOR_USER with offline reason when agent is not connected", async () => {
    const agentId = "a0000000-0000-4000-8000-000000000001";
    const agent = Agent.create({
      agentId,
      name: "A",
      cnpjCpf: "52998224725",
      status: "active",
    });
    const agentRepository = {
      findById: vi.fn().mockResolvedValue(agent),
      findByCnpjCpf: vi.fn(),
      save: vi.fn(),
      update: vi.fn(),
      findAll: vi.fn(),
      findByIds: vi.fn(),
    };
    const agentIdentityRepository = {
      addAgentIds: vi.fn(),
    };
    const agentOnlinePresence = {
      resolvePresenceForUser: vi.fn().mockResolvedValue({ kind: "offline" }),
    };

    const service = new UserAgentService(
      agentRepository as never,
      agentIdentityRepository as never,
      agentOnlinePresence as never,
    );

    const result = await service.addSelfAgentIds("user-1", [agentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AGENT_NOT_ONLINE_FOR_USER");
      expect((result.error as { details?: { reason?: string } }).details?.reason).toBe("offline");
    }
    expect(agentIdentityRepository.addAgentIds).not.toHaveBeenCalled();
  });

  it("returns AGENT_INACTIVE when catalog agent is inactive", async () => {
    const agentId = "c0000000-0000-4000-8000-000000000003";
    const agent = Agent.create({
      agentId,
      name: "C",
      cnpjCpf: "52998224734",
      status: "inactive",
    });
    const agentRepository = {
      findById: vi.fn().mockResolvedValue(agent),
      findByCnpjCpf: vi.fn(),
      save: vi.fn(),
      update: vi.fn(),
      findAll: vi.fn(),
      findByIds: vi.fn(),
    };
    const agentIdentityRepository = { addAgentIds: vi.fn() };
    const agentOnlinePresence = { resolvePresenceForUser: vi.fn() };

    const service = new UserAgentService(
      agentRepository as never,
      agentIdentityRepository as never,
      agentOnlinePresence as never,
    );

    const result = await service.addSelfAgentIds("user-1", [agentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AGENT_INACTIVE");
    }
    expect(agentOnlinePresence.resolvePresenceForUser).not.toHaveBeenCalled();
    expect(agentIdentityRepository.addAgentIds).not.toHaveBeenCalled();
  });

  it("returns AGENT_NOT_ONLINE_FOR_USER with different_account when socket belongs to another user", async () => {
    const agentId = "d0000000-0000-4000-8000-000000000004";
    const agent = Agent.create({
      agentId,
      name: "D",
      cnpjCpf: "11222333000182",
      status: "active",
    });
    const agentRepository = {
      findById: vi.fn().mockResolvedValue(agent),
      findByCnpjCpf: vi.fn(),
      save: vi.fn(),
      update: vi.fn(),
      findAll: vi.fn(),
      findByIds: vi.fn(),
    };
    const agentIdentityRepository = { addAgentIds: vi.fn() };
    const agentOnlinePresence = {
      resolvePresenceForUser: vi.fn().mockResolvedValue({ kind: "online_other_user" }),
    };

    const service = new UserAgentService(
      agentRepository as never,
      agentIdentityRepository as never,
      agentOnlinePresence as never,
    );

    const result = await service.addSelfAgentIds("user-1", [agentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AGENT_NOT_ONLINE_FOR_USER");
      expect((result.error as { details?: { reason?: string } }).details?.reason).toBe(
        "different_account",
      );
    }
  });

  it("delegates to persistence when online and surfaces AGENT_ALREADY_LINKED", async () => {
    const agentId = "b0000000-0000-4000-8000-000000000002";
    const agent = Agent.create({
      agentId,
      name: "B",
      cnpjCpf: "11222333000181",
      status: "active",
    });
    const agentRepository = {
      findById: vi.fn().mockResolvedValue(agent),
      findByCnpjCpf: vi.fn(),
      save: vi.fn(),
      update: vi.fn(),
      findAll: vi.fn(),
      findByIds: vi.fn(),
    };
    const agentIdentityRepository = {
      addAgentIds: vi.fn().mockResolvedValue({
        kind: "agent_bound_to_other_user",
        agentId,
        ownerUserId: "other",
      }),
    };
    const agentOnlinePresence = {
      resolvePresenceForUser: vi.fn().mockResolvedValue({ kind: "online_same_user" }),
    };

    const service = new UserAgentService(
      agentRepository as never,
      agentIdentityRepository as never,
      agentOnlinePresence as never,
    );

    const result = await service.addSelfAgentIds("user-1", [agentId]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AGENT_ALREADY_LINKED");
    }
  });
});
