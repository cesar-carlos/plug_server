import type {
  ClientAgentAccessRecord,
  IClientAgentAccessRepository,
} from "../../domain/repositories/client_agent_access.repository.interface";

interface AccessEntry {
  readonly clientId: string;
  readonly agentId: string;
  readonly approvedAt: Date;
  clientToken: string | null;
}

export class InMemoryClientAgentAccessRepository implements IClientAgentAccessRepository {
  private readonly accessByClient = new Map<string, Map<string, AccessEntry>>();

  private getRow(clientId: string, agentId: string): AccessEntry | undefined {
    return this.accessByClient.get(clientId)?.get(agentId);
  }

  async hasAccess(clientId: string, agentId: string): Promise<boolean> {
    return this.getRow(clientId, agentId) !== undefined;
  }

  async listAccessAgentIdsForClientIn(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<string[]> {
    if (agentIds.length === 0) {
      return [];
    }
    const map = this.accessByClient.get(clientId);
    if (!map) {
      return [];
    }
    const out: string[] = [];
    for (const agentId of new Set(agentIds)) {
      if (map.has(agentId)) {
        out.push(agentId);
      }
    }
    return out;
  }

  async listAgentIdsByClientId(clientId: string): Promise<string[]> {
    const map = this.accessByClient.get(clientId);
    return map ? [...map.keys()] : [];
  }

  async listClientTokenPresenceForClientIn(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, boolean>> {
    const map = this.accessByClient.get(clientId);
    if (!map || agentIds.length === 0) {
      return new Map();
    }
    const out = new Map<string, boolean>();
    for (const agentId of new Set(agentIds)) {
      const entry = map.get(agentId);
      if (entry !== undefined) {
        out.set(agentId, typeof entry.clientToken === "string" && entry.clientToken !== "");
      }
    }
    return out;
  }

  async listByAgentId(agentId: string): Promise<ClientAgentAccessRecord[]> {
    const rows: ClientAgentAccessRecord[] = [];
    for (const [clientId, agents] of this.accessByClient.entries()) {
      const entry = agents.get(agentId);
      if (entry !== undefined) {
        rows.push({
          clientId,
          agentId,
          approvedAt: entry.approvedAt,
          clientToken: entry.clientToken,
        });
      }
    }
    return rows;
  }

  async findByClientAndAgent(
    clientId: string,
    agentId: string,
  ): Promise<ClientAgentAccessRecord | null> {
    const entry = this.getRow(clientId, agentId);
    if (!entry) {
      return null;
    }
    return {
      clientId: entry.clientId,
      agentId: entry.agentId,
      approvedAt: entry.approvedAt,
      clientToken: entry.clientToken,
    };
  }

  async addAccess(clientId: string, agentId: string, approvedAt?: Date): Promise<void> {
    const map = this.accessByClient.get(clientId) ?? new Map<string, AccessEntry>();
    const existing = map.get(agentId);
    map.set(agentId, {
      clientId,
      agentId,
      approvedAt: approvedAt ?? existing?.approvedAt ?? new Date(),
      clientToken: existing?.clientToken ?? null,
    });
    this.accessByClient.set(clientId, map);
  }

  async setClientToken(
    clientId: string,
    agentId: string,
    clientToken: string | null,
  ): Promise<boolean> {
    const map = this.accessByClient.get(clientId);
    const entry = map?.get(agentId);
    if (!entry) {
      return false;
    }
    entry.clientToken = clientToken;
    return true;
  }

  async removeAccess(clientId: string, agentId: string): Promise<void> {
    this.accessByClient.get(clientId)?.delete(agentId);
  }

  async removeAgentIds(clientId: string, agentIds: string[]): Promise<void> {
    const map = this.accessByClient.get(clientId);
    if (!map) {
      return;
    }
    for (const agentId of agentIds) {
      map.delete(agentId);
    }
  }
}
