import { prismaClient } from "../database/prisma/client";
import type {
  AgentAutoUpdateDiagnosticsRepository,
  StoredAgentAutoUpdateDiagnostics,
} from "../../application/services/agent_auto_update_diagnostics.service";

export class PrismaAgentAutoUpdateDiagnosticsRepository
  implements AgentAutoUpdateDiagnosticsRepository
{
  async create(record: StoredAgentAutoUpdateDiagnostics): Promise<void> {
    await prismaClient.agentAutoUpdateDiagnostics.create({
      data: {
        agentId: record.agentId,
        appVersion: record.appVersion,
        checkId: record.checkId,
        checkedAt: record.checkedAt,
        source: record.source,
        completionSource: record.completionSource,
        remoteVersion: record.remoteVersion,
        updateAvailable: record.updateAvailable,
        channel: record.channel,
        rolloutBucket: record.rolloutBucket,
        feedSignatureStatus: record.feedSignatureStatus,
        feedSignatureRequired: record.feedSignatureRequired,
        helperSignatureStatus: record.helperSignatureStatus,
        probeDurationMs: record.probeDurationMs,
        downloadDurationMs: record.downloadDurationMs,
        automaticFailureCount: record.automaticFailureCount,
        errorMessage: record.errorMessage,
      },
    });
  }

  async findRecentByAgentId(
    agentId: string,
    limit: number,
  ): Promise<readonly StoredAgentAutoUpdateDiagnostics[]> {
    const rows = await prismaClient.agentAutoUpdateDiagnostics.findMany({
      where: { agentId },
      orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }],
      take: Math.max(1, Math.floor(limit)),
    });
    return rows.map((row) => ({
      agentId: row.agentId,
      appVersion: row.appVersion,
      checkId: row.checkId,
      checkedAt: row.checkedAt,
      source: row.source as StoredAgentAutoUpdateDiagnostics["source"],
      completionSource:
        row.completionSource as StoredAgentAutoUpdateDiagnostics["completionSource"],
      remoteVersion: row.remoteVersion,
      updateAvailable: row.updateAvailable,
      channel: row.channel as StoredAgentAutoUpdateDiagnostics["channel"],
      rolloutBucket: row.rolloutBucket,
      feedSignatureStatus:
        row.feedSignatureStatus as StoredAgentAutoUpdateDiagnostics["feedSignatureStatus"],
      feedSignatureRequired: row.feedSignatureRequired,
      helperSignatureStatus:
        row.helperSignatureStatus as StoredAgentAutoUpdateDiagnostics["helperSignatureStatus"],
      probeDurationMs: row.probeDurationMs,
      downloadDurationMs: row.downloadDurationMs,
      automaticFailureCount: row.automaticFailureCount,
      errorMessage: row.errorMessage,
    }));
  }

  async pruneBefore(cutoff: Date, batchSize: number): Promise<number> {
    const rows = await prismaClient.$queryRaw<Array<{ deleted: number | bigint }>>`
      WITH candidate AS (
        SELECT id
        FROM agent_auto_update_diagnostics
        WHERE checked_at < ${cutoff}
        ORDER BY checked_at ASC
        LIMIT ${Math.max(1, Math.floor(batchSize))}
      ),
      deleted AS (
        DELETE FROM agent_auto_update_diagnostics target
        USING candidate
        WHERE target.id = candidate.id
        RETURNING target.id
      )
      SELECT COUNT(*)::int AS deleted FROM deleted
    `;
    const deleted = rows[0]?.deleted ?? 0;
    return typeof deleted === "bigint" ? Number(deleted) : deleted;
  }
}

