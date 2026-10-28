import { describe, expect, it, vi } from "vitest";
import { PwaOfflineAuthorizationService } from "../../../../src/application/services/pwa_offline_authorization.service";
import type { IClientAgentAccessRepository } from "../../../../src/domain/repositories/client_agent_access.repository.interface";
import type { IAgentRepository } from "../../../../src/domain/repositories/agent.repository.interface";
import { isAllowedPwaPushEndpoint } from "../../../../src/domain/policies/pwa_push_endpoint.policy";

describe("PWA authorization", () => {
  it("issues exactly 24 hours only for approved active agents", async () => {
    const access = { listAccessAgentIdsForClientIn: vi.fn().mockResolvedValue(["agent"]) };
    const agents = {
      findByIds: vi.fn().mockResolvedValue([{ agentId: "agent", status: "active" }]),
    };
    const service = new PwaOfflineAuthorizationService(
      access as unknown as IClientAgentAccessRepository,
      agents as unknown as IAgentRepository,
      () => new Date("2026-10-26T10:00:00Z"),
    );
    const result = await service.issue("client", ["agent"]);
    expect(result).toEqual({
      version: 1,
      userId: "client",
      agentIds: ["agent"],
      issuedAt: "2026-10-26T10:00:00.000Z",
      expiresAt: "2026-10-27T10:00:00.000Z",
    });
    expect(access.listAccessAgentIdsForClientIn).toHaveBeenCalledWith("client", ["agent"]);
    access.listAccessAgentIdsForClientIn.mockResolvedValue([]);
    await expect(service.issue("other", ["agent"])).rejects.toMatchObject({ statusCode: 403 });
    access.listAccessAgentIdsForClientIn.mockResolvedValue(["agent"]);
    agents.findByIds.mockResolvedValue([{ agentId: "agent", status: "inactive" }]);
    await expect(service.issue("client", ["agent"])).rejects.toMatchObject({ statusCode: 403 });
  });
  it("rejects private, deceptive and non-TLS push destinations", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/test",
      "https://127.0.0.1/a",
      "https://fcm.googleapis.com.evil.test/a",
      "https://user@fcm.googleapis.com/a",
      "https://fcm.googleapis.com:444/a",
    ]) {
      expect(isAllowedPwaPushEndpoint(endpoint)).toBe(false);
    }
    expect(isAllowedPwaPushEndpoint("https://fcm.googleapis.com/fcm/send/test")).toBe(true);
    expect(isAllowedPwaPushEndpoint("https://wns2-by3p.notify.windows.com/w/?token=test")).toBe(
      true,
    );
  });
});
