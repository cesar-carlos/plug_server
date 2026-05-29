import type { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import { logger } from "../../shared/utils/logger";

/**
 * Optional live-profile hooks used to refresh an agent snapshot from the
 * connected hub before returning it to a client. Kept here (next to its only
 * consumer) so the dedup/refresh concern owns its own contract.
 */
export interface ClientAgentLiveProfileDeps {
  readonly isAgentOnline?: (agentId: string) => boolean | Promise<boolean>;
  readonly refreshAgentProfile?: (agentId: string) => Promise<Agent>;
  /** Called after a client→agent access grant is removed (client-initiated or owner-initiated). */
  readonly onAccessRevoked?: (clientId: string, agentId: string) => void;
}

/**
 * Refreshes agent profile snapshots from the live hub with two guards that keep
 * a UI polling burst cheap:
 *
 * - **In-flight dedup**: concurrent refreshes for the same `agentId` share one
 *   promise instead of issuing N hub round-trips.
 * - **Recent-result TTL**: a snapshot refreshed within
 *   {@link AgentSnapshotRefresher.RECENT_TTL_MS} is reused without a new call.
 *
 * Extracted from `ClientAgentAccessService` (which had grown into a god class)
 * so the caching/dedup behavior is cohesive and unit-testable in isolation.
 */
export class AgentSnapshotRefresher {
  /** Max parallel live-profile refreshes when reconciling a page of agents. */
  private static readonly REFRESH_CONCURRENCY = 4;
  /** Window during which a freshly refreshed snapshot is reused as-is. */
  private static readonly RECENT_TTL_MS = 30_000;

  private readonly refreshInFlight = new Map<string, Promise<Agent>>();
  private readonly recentlyRefreshed = new Map<
    string,
    { readonly agent: Agent; readonly refreshedAtMs: number }
  >();

  constructor(
    private readonly agentRepository: Pick<IAgentRepository, "findById">,
    private readonly liveProfileDeps?: ClientAgentLiveProfileDeps,
  ) {}

  /**
   * Refreshes the online agents in `items` (concurrency-limited) and returns a
   * new array with the refreshed snapshots substituted in. Offline agents and
   * agents whose refresh failed keep their persisted snapshot. Generic over the
   * item shape so callers can carry extra fields (e.g. `hasClientToken`).
   */
  async refreshListItems<T extends { readonly agent: Agent }>(
    clientId: string,
    items: readonly T[],
  ): Promise<T[]> {
    if (items.length === 0) {
      return [];
    }

    const refreshedByAgentId = new Map<string, Agent>();
    const onlineChecks = await Promise.all(
      items.map(async (item) => ({
        item,
        online: (await this.liveProfileDeps?.isAgentOnline?.(item.agent.agentId)) === true,
      })),
    );
    const candidates = onlineChecks.filter((entry) => entry.online).map((entry) => entry.item);

    let nextIndex = 0;
    const concurrency = Math.max(
      1,
      Math.min(AgentSnapshotRefresher.REFRESH_CONCURRENCY, candidates.length),
    );
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (nextIndex < candidates.length) {
          const item = candidates[nextIndex];
          nextIndex += 1;
          if (!item) {
            continue;
          }
          const refreshed = await this.resolvePreferredSnapshotWithDedup(
            clientId,
            item.agent.agentId,
            item.agent,
          );
          refreshedByAgentId.set(item.agent.agentId, refreshed);
        }
      }),
    );

    return items.map((item) => ({
      ...item,
      agent: refreshedByAgentId.get(item.agent.agentId) ?? item.agent,
    }));
  }

  /**
   * Returns the preferred snapshot for a single agent: the live hub profile when
   * the agent is online (falling back to persisted data on failure), otherwise
   * the persisted snapshot. No dedup/TTL caching — use for single-agent reads.
   */
  async resolvePreferredSnapshot(
    clientId: string,
    agentId: string,
    persistedAgent: Agent,
  ): Promise<Agent> {
    if (this.liveProfileDeps?.refreshAgentProfile === undefined) {
      return persistedAgent;
    }
    if ((await this.liveProfileDeps.isAgentOnline?.(agentId)) !== true) {
      return persistedAgent;
    }

    try {
      return await this.liveProfileDeps.refreshAgentProfile(agentId);
    } catch (error) {
      logger.warn("client_agent_live_profile_refresh_failed", {
        clientId,
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return (await this.agentRepository.findById(agentId)) ?? persistedAgent;
    }
  }

  private async resolvePreferredSnapshotWithDedup(
    clientId: string,
    agentId: string,
    persistedAgent: Agent,
  ): Promise<Agent> {
    const nowMs = Date.now();
    const recent = this.recentlyRefreshed.get(agentId);
    if (
      recent !== undefined &&
      nowMs - recent.refreshedAtMs < AgentSnapshotRefresher.RECENT_TTL_MS
    ) {
      return recent.agent;
    }

    const inFlight = this.refreshInFlight.get(agentId);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const refreshPromise = this.resolvePreferredSnapshot(clientId, agentId, persistedAgent)
      .then((agent) => {
        this.recentlyRefreshed.set(agentId, { agent, refreshedAtMs: Date.now() });
        return agent;
      })
      .finally(() => {
        this.refreshInFlight.delete(agentId);
      });
    this.refreshInFlight.set(agentId, refreshPromise);
    return refreshPromise;
  }
}
