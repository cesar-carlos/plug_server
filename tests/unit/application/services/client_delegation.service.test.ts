import { describe, it, expect, vi, type MockInstance } from "vitest";
import { ClientDelegationService } from "../../../../src/application/services/client_delegation.service";
import { InMemoryClientDelegationRepository } from "../../../../src/infrastructure/repositories/in_memory_client_delegation.repository";
import type { IClientRepository } from "../../../../src/domain/repositories/client.repository.interface";
import { randomUUID } from "node:crypto";
describe("Client delegation deadlines and credential epochs", () => {
  const fixture = (): {
    service: ClientDelegationService;
    create: MockInstance<InMemoryClientDelegationRepository["create"]>;
    advance: () => void;
    block: () => void;
    rotate: () => void;
  } => {
    let now = new Date(),
      active = true,
      epoch = new Date();
    const repo = new InMemoryClientDelegationRepository();
    const create = vi.spyOn(repo, "create");
    const clients = {
      findActiveSnapshotById: vi.fn(async () => ({
        id: "client-fixture",
        status: active ? "active" : "blocked",
        credentialsUpdatedAt: epoch,
      })),
    } as unknown as IClientRepository;
    const service = new ClientDelegationService(repo, clients, () => now);
    return {
      service,
      create,
      advance: () => {
        now = new Date(now.getTime() + 30 * 86400000);
      },
      block: () => {
        active = false;
      },
      rotate: () => {
        epoch = new Date(epoch.getTime() + 1);
      },
    };
  };
  it("stores a hash and never the opaque credential; expires exactly after 30 days", async () => {
    const f = fixture(),
      binding = { personaId: randomUUID(), audience: "https://mcp.fixture.test" };
    const issued = await f.service.create("client-fixture", binding);
    expect(f.create.mock.calls[0]![0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(f.create.mock.calls)).not.toContain(issued.credential);
    expect((await f.service.verify(issued.credential, binding)).active).toBe(true);
    expect(issued.administrative).toEqual(["gerenciar_fontes"]);
    f.advance();
    await expect(f.service.verify(issued.credential, binding)).rejects.toThrow();
  });
  it("stores only explicitly selected scopes and cannot expand them through verification", async () => {
    const f = fixture(),
      binding = { personaId: randomUUID(), audience: "https://mcp.fixture.test" };
    const issued = await f.service.create("client-fixture", {
      ...binding,
      administrative: ["treinar", "publicar", "gerenciar_tokens", "gerenciar_integracoes"],
    });
    expect(issued.administrative).not.toContain("gerenciar_fontes");
    expect((await f.service.verify(issued.credential, binding)).administrative).toEqual(
      issued.administrative,
    );
  });
  it("rejects blocked Clients and any credential epoch change", async () => {
    for (const kind of ["block", "rotate"] as const) {
      const f = fixture(),
        binding = { personaId: randomUUID(), audience: "https://mcp.fixture.test" };
      const issued = await f.service.create("client-fixture", binding);
      f[kind]();
      await expect(f.service.verify(issued.credential, binding)).rejects.toThrow();
    }
    const f = fixture();
    f.block();
    await expect(
      f.service.create("client-fixture", {
        personaId: randomUUID(),
        audience: "https://mcp.fixture.test",
      }),
    ).rejects.toThrow();
  });
});
