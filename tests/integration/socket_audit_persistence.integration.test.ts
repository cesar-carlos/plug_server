import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prismaClient } from "../../src/infrastructure/database/prisma/client";
import {
  recordSocketAuditEvent,
  flushPendingSocketAuditEvents,
} from "../../src/application/services/socket_audit.service";
import { env } from "../../src/shared/config/env";
import { socketEvents } from "../../src/shared/constants/socket_events";
import {
  assertInfrastructureOrSkip,
  probeDatabaseInfrastructure,
  integrationHookTimeoutMs,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

describe("socket audit persistence", () => {
  let probe: InfrastructureProbeResult = { ok: false, reason: "probe not started" };
  beforeAll(async () => {
    probe = (await probeDatabaseInfrastructure()).probe;
  }, integrationHookTimeoutMs);

  it("persists correlated relay response, chunk and complete audit records in PostgreSQL", async (ctx) => {
    assertInfrastructureOrSkip(ctx, probe);
    const requestId = randomUUID();
    const samplePercent = env.socketAuditHighVolumeSamplePercent;
    Object.assign(env, { socketAuditHighVolumeSamplePercent: 100 });
    try {
      for (const eventType of [
        socketEvents.relayRpcResponse,
        socketEvents.relayRpcChunk,
        socketEvents.relayRpcComplete,
      ]) {
        await recordSocketAuditEvent({
          eventType,
          requestId,
          actorSocketId: "isolated-audit-test",
          direction: "agent_to_consumer",
          payload: { request_id: requestId },
        });
      }
      await flushPendingSocketAuditEvents();
      const rows = await prismaClient.$queryRaw<
        Array<{ event_type: string; payload_json: { request_id: string } }>
      >`SELECT event_type, payload_json FROM audit_events WHERE request_id = ${requestId}`;
      expect(rows.map((row) => row.event_type).sort()).toEqual(
        [
          socketEvents.relayRpcResponse,
          socketEvents.relayRpcChunk,
          socketEvents.relayRpcComplete,
        ].sort(),
      );
      expect(rows.every((row) => row.payload_json.request_id === requestId)).toBe(true);
    } finally {
      Object.assign(env, { socketAuditHighVolumeSamplePercent: samplePercent });
      await prismaClient.$executeRaw`DELETE FROM audit_events WHERE request_id = ${requestId}`;
    }
  });
});
