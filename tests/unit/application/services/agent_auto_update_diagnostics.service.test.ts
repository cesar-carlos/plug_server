import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentAutoUpdateDiagnosticsService,
  type AgentAutoUpdateDiagnosticsRepository,
  type StoredAgentAutoUpdateDiagnostics,
} from "../../../../src/application/services/agent_auto_update_diagnostics.service";
import { env } from "../../../../src/shared/config/env";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "../../../../src/shared/metrics/socket_agent.metrics";

class MemoryDiagnosticsRepository implements AgentAutoUpdateDiagnosticsRepository {
  readonly rows: StoredAgentAutoUpdateDiagnostics[] = [];

  async create(record: StoredAgentAutoUpdateDiagnostics): Promise<void> {
    this.rows.push(record);
  }

  async pruneBefore(): Promise<number> {
    return 0;
  }
}

const originalEnabled = env.agentAutoUpdateDiagnosticsEnabled;
const originalWindowMs = env.agentAutoUpdateDiagnosticsRateLimitWindowMs;
const originalRateLimitMax = env.agentAutoUpdateDiagnosticsRateLimitMax;
const originalMaxPayloadBytes = env.agentAutoUpdateDiagnosticsMaxPayloadBytes;
const originalMaxMessageBytes = env.agentAutoUpdateDiagnosticsMaxMessageBytes;

const validParams = {
  agentId: "38f677f9-7420-4f9e-a84c-9694f1234f0b",
  appVersion: "1.6.8+1",
  checkId: "018f61a0-0000-7000-8000-000000000001",
  checkedAt: "2026-05-31T12:00:00.000Z",
  source: "background",
  completionSource: "updateNotAvailable",
  remoteVersion: null,
  updateAvailable: false,
  channel: "stable",
  rolloutBucket: 42,
  feedSignatureStatus: "valid",
  feedSignatureRequired: true,
  helperSignatureStatus: "valid",
  probeDurationMs: 123,
  downloadDurationMs: null,
  automaticFailureCount: 0,
  errorMessage: null,
} as const;

describe("AgentAutoUpdateDiagnosticsService", () => {
  let repository: MemoryDiagnosticsRepository;
  let service: AgentAutoUpdateDiagnosticsService;
  let nowMs: number;

  beforeEach(() => {
    repository = new MemoryDiagnosticsRepository();
    nowMs = Date.parse("2026-05-31T12:00:10.000Z");
    env.agentAutoUpdateDiagnosticsEnabled = true;
    env.agentAutoUpdateDiagnosticsRateLimitWindowMs = 60_000;
    env.agentAutoUpdateDiagnosticsRateLimitMax = 1;
    env.agentAutoUpdateDiagnosticsMaxPayloadBytes = 16 * 1024;
    env.agentAutoUpdateDiagnosticsMaxMessageBytes = 64 * 1024;
    resetSocketAgentMetrics();
    service = new AgentAutoUpdateDiagnosticsService(repository, {
      now: () => nowMs,
    });
  });

  afterEach(() => {
    env.agentAutoUpdateDiagnosticsEnabled = originalEnabled;
    env.agentAutoUpdateDiagnosticsRateLimitWindowMs = originalWindowMs;
    env.agentAutoUpdateDiagnosticsRateLimitMax = originalRateLimitMax;
    env.agentAutoUpdateDiagnosticsMaxPayloadBytes = originalMaxPayloadBytes;
    env.agentAutoUpdateDiagnosticsMaxMessageBytes = originalMaxMessageBytes;
    resetSocketAgentMetrics();
  });

  it("accepts a valid notification, persists sanitized diagnostics, and truncates errorMessage", async () => {
    const longError = "x".repeat(1_500);

    const result = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validParams,
          errorMessage: longError,
        },
      },
    });

    expect(result).toEqual({ status: "accepted" });
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      agentId: validParams.agentId,
      appVersion: "1.6.8+1",
      checkedAt: new Date(validParams.checkedAt),
      source: "background",
      completionSource: "updateNotAvailable",
      errorMessage: "x".repeat(1_024),
    });
    expect(getSocketAgentMetricsSnapshot().autoUpdateDiagnostics).toEqual({
      received: 1,
      accepted: 1,
      rateLimitedDrop: 0,
      validationDrop: 0,
      persistFailed: 0,
    });
  });

  it("rejects requests with id because diagnostics push is a JSON-RPC notification", async () => {
    const result = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        id: "request-id",
        method: "agent.autoUpdate.diagnostics.push",
        params: validParams,
      },
    });

    expect(result.status).toBe("validation_drop");
    expect(repository.rows).toHaveLength(0);
    expect(getSocketAgentMetricsSnapshot().autoUpdateDiagnostics.validationDrop).toBe(1);
  });

  it("rejects unknown fields and authenticated agent id mismatches", async () => {
    const withExtra = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validParams,
          installerPath: "C:\\secret\\installer.exe",
        },
      },
    });
    const mismatch = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validParams,
          agentId: "other-agent",
        },
      },
    });

    expect(withExtra.status).toBe("validation_drop");
    expect(mismatch.status).toBe("validation_drop");
    expect(repository.rows).toHaveLength(0);
    expect(getSocketAgentMetricsSnapshot().autoUpdateDiagnostics.validationDrop).toBe(2);
  });

  it("drops silently when the same agent exceeds one push per minute", async () => {
    const first = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: validParams,
      },
    });
    nowMs += 1_000;
    const second = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validParams,
          checkId: "018f61a0-0000-7000-8000-000000000002",
        },
      },
    });

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("rate_limited_drop");
    expect(repository.rows).toHaveLength(1);
    expect(getSocketAgentMetricsSnapshot().autoUpdateDiagnostics).toMatchObject({
      received: 2,
      accepted: 1,
      rateLimitedDrop: 1,
    });
  });

  it("honors a configurable max accepted pushes per rate-limit window", async () => {
    env.agentAutoUpdateDiagnosticsRateLimitMax = 2;

    const first = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: validParams,
      },
    });
    nowMs += 1_000;
    const second = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validParams,
          checkId: "018f61a0-0000-7000-8000-000000000002",
        },
      },
    });
    nowMs += 1_000;
    const third = await service.ingestNotification({
      authenticatedAgentId: validParams.agentId,
      socketId: "socket-1",
      messageBytes: 512,
      notification: {
        jsonrpc: "2.0",
        method: "agent.autoUpdate.diagnostics.push",
        params: {
          ...validParams,
          checkId: "018f61a0-0000-7000-8000-000000000003",
        },
      },
    });

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(third.status).toBe("rate_limited_drop");
    expect(repository.rows).toHaveLength(2);
    expect(getSocketAgentMetricsSnapshot().autoUpdateDiagnostics).toMatchObject({
      received: 3,
      accepted: 2,
      rateLimitedDrop: 1,
    });
  });
});
