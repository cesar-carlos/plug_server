import { beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../../../../src/domain/entities/agent.entity";
import { InMemoryAgentRepository } from "../../../../src/infrastructure/repositories/in_memory_agent.repository";
import { AgentProfileSyncService } from "../../../../src/application/services/agent_profile_sync.service";
import type { AgentProfileSyncRpcError } from "../../../../src/application/services/agent_profile_sync.service";
import { AgentSelfProfileService } from "../../../../src/application/services/agent_self_profile.service";
import type { AgentCommandDispatcher } from "../../../../src/application/agent_commands/execute_agent_command";
import type { AppError } from "../../../../src/shared/errors/app_error";
import {
  agentProfileReliabilityMetrics,
  resetAgentProfileReliabilityMetricsForTests,
} from "../../../../src/application/services/agent_profile_reliability_metrics.service";

describe("AgentProfileSyncService", () => {
  const agentId = "1f94921e-8f9d-43f7-8fae-ab18ec981901";

  let agentRepository: InMemoryAgentRepository;
  let service: AgentProfileSyncService;

  beforeEach(() => {
    agentRepository = new InMemoryAgentRepository();
    service = new AgentProfileSyncService(new AgentSelfProfileService(agentRepository));
    resetAgentProfileReliabilityMetricsForTests();
  });

  it("should persist the pulled profile for the authenticated agent when rpc result omits agent_id", async () => {
    const dispatch: AgentCommandDispatcher = async () => ({
      requestId: "req-1",
      response: {
        jsonrpc: "2.0",
        id: "rpc-1",
        result: {
          profile_version: 7,
          updated_at: "2026-04-08T10:20:00.000Z",
          profile: {
            name: "Pulled Agent",
            trade_name: "Pulled Trade",
          },
        },
      },
    });

    const synced = await service.syncFromConnectedAgent({
      agentId,
      userId: "user-1",
      dispatch,
    });

    expect(synced.agentId).toBe(agentId);
    expect(synced.name).toBe("Pulled Agent");
    expect(synced.tradeName).toBe("Pulled Trade");
    expect(synced.lastLoginUserId).toBe("user-1");
    expect(synced.profileUpdatedAt?.toISOString()).toBe("2026-04-08T10:20:00.000Z");
    expect(synced.profileVersion).toBe(7);
    expect(agentProfileReliabilityMetrics.profileSyncFallbackRpcTotal).toBe(1);
  });

  it("should persist the register snapshot without dispatching agent.getProfile", async () => {
    const synced = await service.syncFromRegisterSnapshot({
      agentId,
      userId: "user-register",
      snapshot: {
        profileVersion: 8,
        profileUpdatedAt: new Date("2026-04-08T10:22:00.000Z"),
        profile: {
          name: "Register Agent",
          trade_name: "Register Trade",
          email: "register@test.local",
        },
      },
    });

    expect(synced.agentId).toBe(agentId);
    expect(synced.name).toBe("Register Agent");
    expect(synced.tradeName).toBe("Register Trade");
    expect(synced.lastLoginUserId).toBe("user-register");
    expect(synced.profileUpdatedAt?.toISOString()).toBe("2026-04-08T10:22:00.000Z");
    expect(synced.profileVersion).toBe(8);
    expect(agentProfileReliabilityMetrics.profileSyncRegisterSnapshotTotal).toBe(1);
    expect(agentProfileReliabilityMetrics.profileSyncFallbackRpcTotal).toBe(0);
  });

  it("should fall back to monotonic server version when rpc result omits profile_version", async () => {
    const dispatch: AgentCommandDispatcher = async () => ({
      requestId: "req-legacy",
      response: {
        jsonrpc: "2.0",
        id: "rpc-legacy",
        result: {
          updated_at: "2026-04-08T10:21:00.000Z",
          profile: {
            name: "Legacy Pulled",
            trade_name: "Legacy Trade",
          },
        },
      },
    });

    const synced = await service.syncFromConnectedAgent({
      agentId,
      userId: "user-legacy",
      dispatch,
    });

    expect(synced.profileVersion).toBe(1);
    expect(synced.name).toBe("Legacy Pulled");
  });

  it("should reject mismatched agent_id values returned by agent.getProfile", async () => {
    await agentRepository.save(
      Agent.create({
        agentId,
        name: "Persisted Agent",
        tradeName: "Persisted Trade",
        profileUpdatedAt: new Date("2026-04-08T10:00:00.000Z"),
      }),
    );

    const dispatch: AgentCommandDispatcher = async () => ({
      requestId: "req-2",
      response: {
        jsonrpc: "2.0",
        id: "rpc-2",
        result: {
          agent_id: "other-agent",
          updated_at: "2026-04-08T10:30:00.000Z",
          profile: {
            name: "Injected Agent",
          },
        },
      },
    });

    await expect(
      service.syncFromConnectedAgent({
        agentId,
        dispatch,
      }),
    ).rejects.toMatchObject<AppError>({
      code: "FORBIDDEN",
      statusCode: 403,
    });

    const persisted = await agentRepository.findById(agentId);
    expect(persisted?.name).toBe("Persisted Agent");
    expect(persisted?.tradeName).toBe("Persisted Trade");
    expect(persisted?.profileUpdatedAt?.toISOString()).toBe("2026-04-08T10:00:00.000Z");
    expect(await agentRepository.findById("other-agent")).toBeNull();
  });

  it("should preserve structured RPC error details when agent.getProfile fails", async () => {
    const dispatch: AgentCommandDispatcher = async () => ({
      requestId: "req-auth",
      response: {
        jsonrpc: "2.0",
        id: "rpc-auth",
        error: {
          code: -32001,
          message: "Authentication failed",
          data: {
            reason: "missing_client_token",
            technical_message: "client_token is required",
            retryable: false,
            retry_after_ms: 250,
          },
        },
      },
    });

    await expect(
      service.syncFromConnectedAgent({
        agentId,
        dispatch,
      }),
    ).rejects.toMatchObject<AgentProfileSyncRpcError>({
      code: "AGENT_PROFILE_SYNC_RPC_ERROR",
      statusCode: 502,
      message: "Authentication failed",
      details: {
        rpc_code: -32001,
        rpc_message: "Authentication failed",
        rpc_reason: "missing_client_token",
        technical_message: "client_token is required",
        retryable: false,
        retry_after_ms: 250,
      },
    });
  });
});
