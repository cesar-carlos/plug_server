import type {
  AgentAutoUpdateDiagnosticsRepository,
  StoredAgentAutoUpdateDiagnostics,
} from "../../application/services/agent_auto_update_diagnostics.service";

export class InMemoryAgentAutoUpdateDiagnosticsRepository
  implements AgentAutoUpdateDiagnosticsRepository
{
  private readonly rows: StoredAgentAutoUpdateDiagnostics[] = [];

  async create(record: StoredAgentAutoUpdateDiagnostics): Promise<void> {
    this.rows.push(record);
  }

  async findRecentByAgentId(
    agentId: string,
    limit: number,
  ): Promise<readonly StoredAgentAutoUpdateDiagnostics[]> {
    const safeLimit = Math.max(1, Math.floor(limit));
    return this.rows
      .filter((row) => row.agentId === agentId)
      .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime())
      .slice(0, safeLimit);
  }

  async pruneBefore(cutoff: Date, batchSize: number): Promise<number> {
    const safeBatchSize = Math.max(1, Math.floor(batchSize));
    const candidateIndexes: number[] = [];
    for (let index = 0; index < this.rows.length && candidateIndexes.length < safeBatchSize; index += 1) {
      if (this.rows[index]!.checkedAt < cutoff) {
        candidateIndexes.push(index);
      }
    }
    for (let index = candidateIndexes.length - 1; index >= 0; index -= 1) {
      this.rows.splice(candidateIndexes[index]!, 1);
    }
    return candidateIndexes.length;
  }

  clear(): void {
    this.rows.length = 0;
  }
}

