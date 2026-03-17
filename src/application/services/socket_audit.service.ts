import { randomUUID } from "node:crypto";

import { prismaClient } from "../../infrastructure/database/prisma/client";
import { logger } from "../../shared/utils/logger";

const defaultRetentionDays = 90;
const defaultRetentionIntervalMs = 24 * 60 * 60 * 1000;

let retentionTimer: NodeJS.Timeout | null = null;
let missingTableLogged = false;
let auditTableState: "unknown" | "available" | "missing" = "unknown";

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isAuditTableMissing = (error: unknown): boolean => {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("audit_events") && message.includes("does not exist");
};

const canUseAuditTable = async (): Promise<boolean> => {
  if (auditTableState === "available") {
    return true;
  }

  if (auditTableState === "missing") {
    return false;
  }

  try {
    const rows = await prismaClient.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('public.audit_events') IS NOT NULL AS "exists"
    `;
    const exists = rows[0]?.exists === true;
    auditTableState = exists ? "available" : "missing";

    if (!exists && !missingTableLogged) {
      logger.warn("socket_audit_table_missing", { message: "audit_events table not found" });
      missingTableLogged = true;
    }

    return exists;
  } catch (error: unknown) {
    logger.warn("socket_audit_table_probe_failed", { message: toErrorMessage(error) });
    return false;
  }
};

export interface SocketAuditEventInput {
  readonly eventType: string;
  readonly actorSocketId?: string;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly direction?: "consumer_to_agent" | "agent_to_consumer" | "control";
  readonly conversationId?: string;
  readonly agentId?: string;
  readonly requestId?: string;
  readonly streamId?: string;
  readonly traceId?: string;
  readonly payload?: unknown;
}

export const recordSocketAuditEvent = async (input: SocketAuditEventInput): Promise<void> => {
  if (!(await canUseAuditTable())) {
    return;
  }

  try {
    await prismaClient.$executeRaw`
      INSERT INTO audit_events (
        id,
        event_type,
        actor_socket_id,
        actor_user_id,
        actor_role,
        direction,
        conversation_id,
        agent_id,
        request_id,
        stream_id,
        trace_id,
        payload_json
      ) VALUES (
        ${randomUUID()},
        ${input.eventType},
        ${input.actorSocketId ?? null},
        ${input.actorUserId ?? null},
        ${input.actorRole ?? null},
        ${input.direction ?? null},
        ${input.conversationId ?? null},
        ${input.agentId ?? null},
        ${input.requestId ?? null},
        ${input.streamId ?? null},
        ${input.traceId ?? null},
        ${JSON.stringify(input.payload ?? null)}::jsonb
      )
    `;
  } catch (error: unknown) {
    if (isAuditTableMissing(error)) {
      auditTableState = "missing";
      if (!missingTableLogged) {
        logger.warn("socket_audit_table_missing", { message: toErrorMessage(error) });
        missingTableLogged = true;
      }
      return;
    }

    logger.warn("socket_audit_write_failed", { message: toErrorMessage(error) });
  }
};

export const pruneSocketAuditOlderThanDays = async (
  retentionDays = defaultRetentionDays,
): Promise<number> => {
  if (!(await canUseAuditTable())) {
    return 0;
  }

  const safeDays = Number.isFinite(retentionDays) ? Math.max(1, Math.floor(retentionDays)) : defaultRetentionDays;
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

  try {
    const deleted = await prismaClient.$executeRaw`
      DELETE FROM audit_events
      WHERE created_at < ${cutoff}
    `;

    if (typeof deleted === "number" && deleted > 0) {
      logger.info("socket_audit_pruned", { deleted, retentionDays: safeDays });
    }

    return typeof deleted === "number" ? deleted : 0;
  } catch (error: unknown) {
    if (isAuditTableMissing(error)) {
      auditTableState = "missing";
      if (!missingTableLogged) {
        logger.warn("socket_audit_table_missing", { message: toErrorMessage(error) });
        missingTableLogged = true;
      }
    } else {
      logger.warn("socket_audit_prune_failed", { message: toErrorMessage(error) });
    }
    return 0;
  }
};

export const startSocketAuditRetentionScheduler = (options?: {
  readonly retentionDays?: number;
  readonly intervalMs?: number;
}): void => {
  if (retentionTimer) {
    return;
  }

  const retentionDays = options?.retentionDays ?? defaultRetentionDays;
  const intervalMs = options?.intervalMs ?? defaultRetentionIntervalMs;

  const run = (): void => {
    void pruneSocketAuditOlderThanDays(retentionDays);
  };

  run();
  retentionTimer = setInterval(run, intervalMs);
  retentionTimer.unref?.();
};

export const stopSocketAuditRetentionScheduler = (): void => {
  if (!retentionTimer) {
    return;
  }
  clearInterval(retentionTimer);
  retentionTimer = null;
};
