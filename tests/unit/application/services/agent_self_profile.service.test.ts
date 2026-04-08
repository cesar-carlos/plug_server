import { beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../../../src/domain/entities/agent.entity";
import { AppError } from "../../../../src/shared/errors/app_error";
import { AgentSelfProfileService } from "../../../../src/application/services/agent_self_profile.service";
import { resetAgentProfileReliabilityMetricsForTests } from "../../../../src/application/services/agent_profile_reliability_metrics.service";
import { InMemoryAgentRepository } from "../../../../src/infrastructure/repositories/in_memory_agent.repository";

describe("AgentSelfProfileService", () => {
  const agentId = "8c3220dd-e0eb-47c2-8b97-bdb776f4d65d";

  let agentRepository: InMemoryAgentRepository;
  let service: AgentSelfProfileService;

  beforeEach(async () => {
    resetAgentProfileReliabilityMetricsForTests();
    agentRepository = new InMemoryAgentRepository();
    service = new AgentSelfProfileService(agentRepository);

    await agentRepository.save(
      Agent.create({
        agentId,
        name: "Persisted Agent",
        tradeName: "Persisted Trade",
        document: "11222333000181",
        documentType: "cnpj",
        phone: "1130303030",
        mobile: "11999999999",
        email: "persisted@test.local",
        notes: "persisted notes",
        address: {
          street: "Rua Um",
          number: "100",
          district: "Centro",
          postalCode: "01001000",
          city: "Sao Paulo",
          state: "SP",
        },
        profileUpdatedAt: new Date("2026-04-08T10:00:00.000Z"),
        lastLoginUserId: "user-1",
      }),
    );
  });

  it("should apply partial patch and preserve omitted fields", async () => {
    const updated = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromHttpPayload({
        tradeName: "Updated Trade",
        address: {
          city: "Campinas",
        },
      }),
      source: "http",
      profileUpdatedAt: new Date("2026-04-08T10:05:00.000Z"),
      lastLoginUserId: "user-2",
    });

    expect(updated.name).toBe("Persisted Agent");
    expect(updated.tradeName).toBe("Updated Trade");
    expect(updated.document).toBe("11222333000181");
    expect(updated.city).toBe("Campinas");
    expect(updated.street).toBe("Rua Um");
    expect(updated.lastLoginUserId).toBe("user-2");
    expect(updated.profileUpdatedAt?.toISOString()).toBe("2026-04-08T10:05:00.000Z");
    expect(updated.profileVersion).toBe(1);
  });

  it("should clear nullable root and nested address fields", async () => {
    const updated = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromHttpPayload({
        tradeName: null,
        phone: null,
        address: {
          city: null,
          postalCode: null,
        },
      }),
      source: "http",
      profileUpdatedAt: new Date("2026-04-08T10:06:00.000Z"),
    });

    expect(updated.tradeName).toBeUndefined();
    expect(updated.phone).toBeUndefined();
    expect(updated.city).toBeUndefined();
    expect(updated.postalCode).toBeUndefined();
    expect(updated.street).toBe("Rua Um");
  });

  it("should skip stale pull sync updates when persisted profile is newer", async () => {
    const result = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromPulledProfile({
        name: "Older Remote Snapshot",
        trade_name: "Older Trade",
      }),
      source: "pull_sync",
      profileUpdatedAt: new Date("2026-04-08T09:59:59.000Z"),
      lastLoginUserId: "user-3",
    });

    expect(result.name).toBe("Persisted Agent");
    expect(result.tradeName).toBe("Persisted Trade");
    expect(result.lastLoginUserId).toBe("user-1");
    expect(result.profileUpdatedAt?.toISOString()).toBe("2026-04-08T10:00:00.000Z");
  });

  it("should skip pull sync updates without updated_at when the persisted profile is already versioned", async () => {
    const result = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromPulledProfile({
        name: "Unversioned Remote Snapshot",
        trade_name: "Should Not Overwrite",
      }),
      source: "pull_sync",
      lastLoginUserId: "user-3",
    });

    expect(result.name).toBe("Persisted Agent");
    expect(result.tradeName).toBe("Persisted Trade");
    expect(result.lastLoginUserId).toBe("user-1");
    expect(result.profileUpdatedAt?.toISOString()).toBe("2026-04-08T10:00:00.000Z");
  });

  it("should create a missing catalog row when the patch includes name", async () => {
    const createdAgentId = "cb060fe8-dc0d-456a-a781-b6143c03dc92";

    const created = await service.persistProfilePatch({
      agentId: createdAgentId,
      patch: service.toPatchFromSocketPayload({
        name: "Created From Socket",
        trade_name: "Created Trade",
        document: "52998224725",
        document_type: "cpf",
        address: {
          city: "Cuiaba",
        },
      }),
      source: "socket",
      profileUpdatedAt: new Date("2026-04-08T10:10:00.000Z"),
      lastLoginUserId: "user-4",
    });

    expect(created.agentId).toBe(createdAgentId);
    expect(created.name).toBe("Created From Socket");
    expect(created.tradeName).toBe("Created Trade");
    expect(created.document).toBe("52998224725");
    expect(created.documentType).toBe("cpf");
    expect(created.city).toBe("Cuiaba");
    expect(created.lastLoginUserId).toBe("user-4");
  });

  it("should reject creating a missing catalog row without name", async () => {
    await expect(
      service.persistProfilePatch({
        agentId: "7d1116ca-5840-4c45-b887-c24a0a4b0c9b",
        patch: service.toPatchFromHttpPayload({
          notes: "missing name for creation",
        }),
        source: "http",
      }),
    ).rejects.toMatchObject<AppError>({
      code: "BAD_REQUEST",
    });
  });

  it("should reject HTTP patch when expectedProfileVersion does not match current", async () => {
    await expect(
      service.persistProfilePatch({
        agentId,
        patch: service.toPatchFromHttpPayload({ tradeName: "X" }),
        source: "http",
        profileUpdatedAt: new Date("2026-04-08T10:07:00.000Z"),
        expectedProfileVersion: 99,
      }),
    ).rejects.toMatchObject<AppError>({
      code: "CONFLICT",
    });
  });

  it("should return idempotent result when dedupeKey repeats with the same payload", async () => {
    const first = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromHttpPayload({ tradeName: "Idem Trade" }),
      source: "http",
      profileUpdatedAt: new Date("2026-04-08T10:08:00.000Z"),
      dedupeKey: "req-idem-1",
    });
    expect(first.profileVersion).toBe(1);
    expect(first.tradeName).toBe("Idem Trade");

    const second = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromHttpPayload({ tradeName: "Idem Trade" }),
      source: "http",
      profileUpdatedAt: new Date("2026-04-08T10:09:00.000Z"),
      dedupeKey: "req-idem-1",
    });
    expect(second.profileVersion).toBe(1);
    expect(second.tradeName).toBe("Idem Trade");
  });

  it("should reject when dedupeKey repeats with a different payload", async () => {
    await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromHttpPayload({ tradeName: "First" }),
      source: "http",
      profileUpdatedAt: new Date("2026-04-08T10:10:00.000Z"),
      dedupeKey: "req-idem-2",
    });

    await expect(
      service.persistProfilePatch({
        agentId,
        patch: service.toPatchFromHttpPayload({ tradeName: "Second" }),
        source: "http",
        profileUpdatedAt: new Date("2026-04-08T10:11:00.000Z"),
        dedupeKey: "req-idem-2",
      }),
    ).rejects.toMatchObject<AppError>({
      code: "CONFLICT",
    });
  });

  it("should apply pull_sync using remoteProfileVersion and skip when remote is stale or equal in content", async () => {
    await agentRepository.save(
      Agent.create({
        agentId,
        name: "V3 Agent",
        tradeName: "V3 Trade",
        profileUpdatedAt: new Date("2026-04-08T10:00:00.000Z"),
        profileVersion: 3,
        lastLoginUserId: "user-1",
      }),
    );

    const stale = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromPulledProfile({
        name: "Stale Remote",
        trade_name: "Stale",
      }),
      source: "pull_sync",
      remoteProfileVersion: 2,
      profileUpdatedAt: new Date("2026-04-08T11:00:00.000Z"),
    });
    expect(stale.name).toBe("V3 Agent");
    expect(stale.profileVersion).toBe(3);

    const same = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromPulledProfile({
        name: "V3 Agent",
        trade_name: "V3 Trade",
      }),
      source: "pull_sync",
      remoteProfileVersion: 3,
      profileUpdatedAt: new Date("2026-04-08T12:00:00.000Z"),
    });
    expect(same.name).toBe("V3 Agent");
    expect(same.profileVersion).toBe(3);

    await expect(
      service.persistProfilePatch({
        agentId,
        patch: service.toPatchFromPulledProfile({
          name: "Same Version Remote",
          trade_name: "Ignored",
        }),
        source: "pull_sync",
        remoteProfileVersion: 3,
        profileUpdatedAt: new Date("2026-04-08T12:30:00.000Z"),
      }),
    ).rejects.toMatchObject<AppError>({ code: "CONFLICT" });

    const newer = await service.persistProfilePatch({
      agentId,
      patch: service.toPatchFromPulledProfile({
        name: "Remote v5",
        trade_name: "Fresh Trade",
      }),
      source: "pull_sync",
      remoteProfileVersion: 5,
      profileUpdatedAt: new Date("2026-04-08T13:00:00.000Z"),
    });
    expect(newer.name).toBe("Remote v5");
    expect(newer.tradeName).toBe("Fresh Trade");
    expect(newer.profileVersion).toBe(5);
  });
});
