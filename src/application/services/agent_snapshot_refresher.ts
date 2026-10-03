import type { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import { IndexedTtlStore } from "../../shared/utils/indexed_ttl_store";
import { logger } from "../../shared/utils/logger";
import type {
  AgentProfileRefreshCoordinator,
  ProfileRefreshWork,
  RefreshOutcome,
} from "./agent_profile_refresh_coordinator";

export interface ClientAgentLiveProfileDeps {
  readonly isAgentOnline?: (agentId: string) => boolean | Promise<boolean>;
  readonly resolveOnlineAgentIds?: (agentIds: readonly string[]) => Promise<ReadonlySet<string>>;
  readonly refreshAgentProfile?: (agentId: string) => Promise<Agent>;
  readonly onAccessRevoked?: (clientId: string, agentId: string) => void;
}

interface RefreshFlight {
  readonly work: ProfileRefreshWork;
  readonly completion: Promise<Agent>;
}

/** List snapshots share completed results and in-flight work; detail always stays fresh. */
export class AgentSnapshotRefresher {
  private static readonly REFRESH_CONCURRENCY = 4;
  private static readonly RECENT_TTL_MS = 30_000;
  private readonly refreshInFlight = new Map<string, RefreshFlight>();
  private readonly completions = new Set<Promise<Agent>>();
  private readonly recentlyRefreshed = new IndexedTtlStore<string, Agent>(
    AgentSnapshotRefresher.RECENT_TTL_MS,
  );
  private closing = false;

  constructor(
    private readonly agentRepository: Pick<IAgentRepository, "findById">,
    private readonly coordinator: AgentProfileRefreshCoordinator,
    private readonly liveProfileDeps?: ClientAgentLiveProfileDeps,
  ) {}

  getMetrics(): ReturnType<AgentProfileRefreshCoordinator["getMetrics"]> & {
    readonly cacheEntries: number;
    readonly cacheExpirations: number;
  } {
    const cache = this.recentlyRefreshed.getCardinality();
    return {
      ...this.coordinator.getMetrics(),
      cacheEntries: cache.entries,
      cacheExpirations: cache.expirations,
    };
  }

  beginShutdown(): void {
    this.closing = true;
    this.coordinator.beginShutdown();
    this.recentlyRefreshed.close();
  }

  async close(): Promise<void> {
    this.beginShutdown();
    await this.coordinator.drain();
    await Promise.allSettled(this.completions);
    this.refreshInFlight.clear();
  }

  async refreshListItems<T extends { readonly agent: Agent }>(
    clientId: string,
    items: readonly T[],
    signal?: AbortSignal,
  ): Promise<T[]> {
    if (items.length === 0 || signal?.aborted) return [...items];
    const ids = [...new Set(items.map((item) => item.agent.agentId))];
    const online = await this.resolveInitialOnline(ids);
    const candidates = items.filter((item) => online.has(item.agent.agentId));
    const refreshedByAgentId = new Map<string, Agent>();
    let nextIndex = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(AgentSnapshotRefresher.REFRESH_CONCURRENCY, candidates.length) },
        async () => {
          while (nextIndex < candidates.length && !signal?.aborted) {
            const item = candidates[nextIndex++]!;
            const refreshed = await this.resolveListSnapshot(clientId, item.agent, signal);
            refreshedByAgentId.set(item.agent.agentId, refreshed);
          }
        },
      ),
    );
    return items.map((item) => ({
      ...item,
      agent: refreshedByAgentId.get(item.agent.agentId) ?? item.agent,
    }));
  }

  async resolvePreferredSnapshot(
    clientId: string,
    agentId: string,
    persistedAgent: Agent,
    signal?: AbortSignal,
  ): Promise<Agent> {
    if (this.liveProfileDeps?.refreshAgentProfile === undefined || signal?.aborted)
      return persistedAgent;
    const flight = this.createFlight(clientId, agentId, persistedAgent, false);
    return flight.work.wait(flight.completion, signal, () => persistedAgent);
  }

  private async resolveListSnapshot(
    clientId: string,
    persistedAgent: Agent,
    signal?: AbortSignal,
  ): Promise<Agent> {
    const agentId = persistedAgent.agentId;
    const recent = this.recentlyRefreshed.get(agentId);
    if (recent !== undefined) return recent;
    let flight = this.refreshInFlight.get(agentId);
    if (flight === undefined) {
      flight = this.createFlight(clientId, agentId, persistedAgent, true);
      this.refreshInFlight.set(agentId, flight);
    }
    return flight.work.wait(flight.completion, signal, () => persistedAgent);
  }

  private createFlight(
    clientId: string,
    agentId: string,
    persistedAgent: Agent,
    cache: boolean,
  ): RefreshFlight {
    const work = this.coordinator.submit(agentId, () =>
      this.liveProfileDeps!.refreshAgentProfile!(agentId),
    );
    const completion = work.result.then(async (outcome) => {
      const agent = await this.resolveOutcome(outcome, clientId, agentId, persistedAgent);
      // The TTL begins after refresh/fallback completes, exactly as before.
      if (cache && !this.closing && outcome.kind !== "cancelled")
        this.recentlyRefreshed.set(agentId, agent);
      return agent;
    });
    this.completions.add(completion);
    // Observe rejection even if every HTTP waiter disconnects.
    void completion.then(
      () => this.forget(completion, agentId, cache),
      () => this.forget(completion, agentId, cache),
    );
    return { work, completion };
  }

  private forget(completion: Promise<Agent>, agentId: string, cache: boolean): void {
    this.completions.delete(completion);
    if (cache && this.refreshInFlight.get(agentId)?.completion === completion)
      this.refreshInFlight.delete(agentId);
  }

  private async resolveOutcome(
    outcome: RefreshOutcome,
    clientId: string,
    agentId: string,
    persistedAgent: Agent,
  ): Promise<Agent> {
    if (outcome.kind === "success") return outcome.agent;
    if (outcome.kind === "presence_error") throw outcome.error;
    if (outcome.kind === "offline") return persistedAgent;
    if (outcome.kind === "refresh_error")
      logger.warn("client_agent_live_profile_refresh_failed", {
        clientId,
        agentId,
        message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
    return (await this.agentRepository.findById(agentId)) ?? persistedAgent;
  }

  private async resolveInitialOnline(ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (this.liveProfileDeps?.refreshAgentProfile === undefined || this.closing) return new Set();
    if (this.liveProfileDeps.resolveOnlineAgentIds !== undefined)
      return this.liveProfileDeps.resolveOnlineAgentIds(ids);
    const online = new Set<string>();
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(AgentSnapshotRefresher.REFRESH_CONCURRENCY, ids.length) },
        async () => {
          while (next < ids.length) {
            const id = ids[next++]!;
            if (await this.liveProfileDeps?.isAgentOnline?.(id)) online.add(id);
          }
        },
      ),
    );
    return online;
  }
}
