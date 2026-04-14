import type { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";
import type {
  AgentProfileCommitInput,
  AgentProfileCommitResult,
} from "../../domain/repositories/agent_profile_commit";
import { AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE } from "../../shared/messages/agent_profile";

export class InMemoryAgentRepository implements IAgentRepository {
  private readonly agentsById = new Map<string, Agent>();
  private readonly profileIdempotency = new Map<
    string,
    { readonly fingerprint: string; readonly resultingVersion: number }
  >();

  async findById(agentId: string): Promise<Agent | null> {
    return this.agentsById.get(agentId) ?? null;
  }

  async findByDocument(document: string): Promise<Agent | null> {
    for (const agent of this.agentsById.values()) {
      if (agent.document === document) return agent;
    }
    return null;
  }

  async findByIds(agentIds: string[]): Promise<Agent[]> {
    return [...new Set(agentIds)]
      .map((agentId) => this.agentsById.get(agentId) ?? null)
      .filter((agent): agent is Agent => agent !== null);
  }

  async findAll(filter?: AgentListFilter): Promise<PaginatedAgentList> {
    let agents = [...this.agentsById.values()];
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);

    if (filter?.agentIds !== undefined) {
      if (filter.agentIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }
      const allowed = new Set(filter.agentIds);
      agents = agents.filter((a) => allowed.has(a.agentId));
    }

    if (filter?.status) {
      agents = agents.filter((a) => a.status === filter.status);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase();
      agents = agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.tradeName?.toLowerCase().includes(q) ?? false) ||
          (a.document?.includes(filter.search!) ?? false),
      );
    }

    const sorted = agents.sort((a, b) => a.name.localeCompare(b.name));
    const start = (page - 1) * pageSize;

    return {
      items: sorted.slice(start, start + pageSize),
      total: sorted.length,
      page,
      pageSize,
    };
  }

  async save(agent: Agent): Promise<void> {
    this.agentsById.set(agent.agentId, agent);
  }

  async update(agent: Agent): Promise<void> {
    this.agentsById.set(agent.agentId, agent);
  }

  async commitAgentProfileChange(input: AgentProfileCommitInput): Promise<AgentProfileCommitResult> {
    const agentId = input.nextAgent.agentId;

    if (input.dedupeKey) {
      const idemKey = `${agentId}::${input.dedupeKey}`;
      const existingIdem = this.profileIdempotency.get(idemKey);
      if (existingIdem) {
        if (existingIdem.fingerprint !== input.patchFingerprint) {
          return {
            status: "conflict",
            message: "Idempotency key reused with a different profile payload",
          };
        }
        const agent = this.agentsById.get(agentId);
        if (!agent) {
          return { status: "conflict", message: "Agent not found after idempotent lookup" };
        }
        return { status: "idempotent", agent };
      }
    }

    if (input.mode === "create") {
      if (InMemoryAgentRepository.anotherAgentOwnsDocument(this.agentsById, agentId, input.nextAgent.document)) {
        return {
          status: "conflict",
          message: AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE,
          reason: "document_not_unique",
        };
      }
      this.agentsById.set(agentId, input.nextAgent);
      if (input.dedupeKey) {
        this.profileIdempotency.set(`${agentId}::${input.dedupeKey}`, {
          fingerprint: input.patchFingerprint,
          resultingVersion: input.nextAgent.profileVersion,
        });
      }
      return { status: "committed", agent: input.nextAgent };
    }

    const current = this.agentsById.get(agentId);
    if (!current || current.profileVersion !== input.previousProfileVersion) {
      return {
        status: "conflict",
        message: "Agent profile version changed concurrently or expected version mismatch",
      };
    }

    if (InMemoryAgentRepository.anotherAgentOwnsDocument(this.agentsById, agentId, input.nextAgent.document)) {
      return {
        status: "conflict",
        message: AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE,
        reason: "document_not_unique",
      };
    }

    this.agentsById.set(agentId, input.nextAgent);
    if (input.dedupeKey) {
      this.profileIdempotency.set(`${agentId}::${input.dedupeKey}`, {
        fingerprint: input.patchFingerprint,
        resultingVersion: input.nextAgent.profileVersion,
      });
    }
    return { status: "committed", agent: input.nextAgent };
  }

  clear(): void {
    this.agentsById.clear();
    this.profileIdempotency.clear();
  }

  private static anotherAgentOwnsDocument(
    agentsById: Map<string, Agent>,
    agentId: string,
    document: string | undefined,
  ): boolean {
    if (document === undefined || document === "") {
      return false;
    }
    for (const agent of agentsById.values()) {
      if (agent.agentId !== agentId && agent.document === document) {
        return true;
      }
    }
    return false;
  }
}
