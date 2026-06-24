import { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentAccessSnapshot,
  IAgentRepository,
  PrincipalAccessQuery,
} from "../../domain/repositories/agent.repository.interface";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import {
  agentAccessDenied,
  agentAlreadyLinked,
  agentInactive,
  agentNotFound,
} from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";
import { env } from "../../shared/config/env";
import { TtlCache } from "../../shared/utils/ttl_cache";

export type AgentAccessPrincipal =
  | { readonly type: "user"; readonly id: string; readonly role?: string }
  | { readonly type: "client"; readonly id: string };

/**
 * Builds the cache key for a principal+agent pair.
 * Format: `"user:<userId>:<agentId>"` or `"client:<clientId>:<agentId>"`.
 */
const accessCacheKey = (principalType: string, principalId: string, agentId: string): string =>
  `${principalType}:${principalId}:${agentId}`;

/** Positive-result cache key for idempotent `bindOwnershipOnRegister` after eligibility checks. */
const bindRegisterCacheKey = (userId: string, agentId: string): string =>
  `bindReg:user:${userId}:${agentId}`;

const toPrincipalAccessQuery = (principal: AgentAccessPrincipal): PrincipalAccessQuery =>
  principal.type === "user"
    ? { type: "user", userId: principal.id }
    : { type: "client", clientId: principal.id };

export class AgentAccessService {
  /**
   * Short-lived positive-result cache for `assertPrincipalAccess`.
   * Eliminates repeated DB queries on bridge commands within the TTL window.
   * Only caches successful (access granted) results — denied/not-found results
   * are never cached so re-grants take effect immediately.
   * Set `AGENT_ACCESS_CACHE_TTL_MS=0` to disable.
   */
  private readonly accessCache = new TtlCache<string, AgentAccessSnapshot>(
    env.agentAccessCacheTtlMs,
    env.agentAccessCacheMaxSize,
  );

  /**
   * After `assertOwnershipEligible` succeeds, skip repeated catalog stub + `bindIfUnbound`
   * within TTL (reconnect/register storms). Always invalidated together with access-cache hooks.
   * Disabled when `AGENT_REGISTER_BIND_CACHE_TTL_MS=0`.
   */
  private readonly bindRegisterCache: TtlCache<string, true> | null =
    env.agentRegisterBindCacheTtlMs > 0
      ? new TtlCache<string, true>(
          env.agentRegisterBindCacheTtlMs,
          env.agentRegisterBindCacheMaxSize,
        )
      : null;

  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
    private readonly clientAgentAccessRepository: IClientAgentAccessRepository,
  ) {}

  /**
   * Asserts that:
   * 1. The agent exists in the catalog.
   * 2. The agent status is "active".
   * 3. The user has an explicit binding to the agent.
   *
   * Returns a lightweight snapshot ({ agentId, status }) on success. Callers
   * that need the full `Agent` entity should call `agentRepository.findById`
   * separately — most don't.
   */
  async assertAccess(userId: string, agentId: string): Promise<Result<AgentAccessSnapshot>> {
    return this.assertPrincipalAccess({ type: "user", id: userId }, agentId);
  }

  /**
   * Asserts that:
   * 1. The agent exists in the catalog.
   * 2. The agent status is "active".
   * 3. The principal has explicit access to the agent.
   *
   * Uses a lightweight projection of the agent row (id + status) — the wide
   * profile/address columns are not loaded.
   */
  async assertPrincipalAccess(
    principal: AgentAccessPrincipal,
    agentId: string,
  ): Promise<Result<AgentAccessSnapshot>> {
    if (env.agentAccessCacheTtlMs > 0) {
      const key = accessCacheKey(principal.type, principal.id, agentId);
      const cached = this.accessCache.get(key);
      if (cached !== undefined) {
        return ok(cached);
      }
    }

    if (principal.type === "user" && principal.role === "admin") {
      const snapshot = await this.agentRepository.findAccessSnapshotById(agentId);
      if (!snapshot) {
        return err(agentNotFound(agentId));
      }
      if (snapshot.status !== "active") {
        return err(agentInactive(agentId));
      }
      if (env.agentAccessCacheTtlMs > 0) {
        this.accessCache.set(accessCacheKey(principal.type, principal.id, agentId), snapshot);
      }
      return ok(snapshot);
    }

    const combinedCheck = this.agentRepository.findPrincipalAccessCheck?.bind(this.agentRepository);
    if (combinedCheck) {
      const check = await combinedCheck(agentId, toPrincipalAccessQuery(principal));
      if (check.outcome === "not_found") {
        return err(agentNotFound(agentId));
      }
      if (check.outcome === "inactive") {
        return err(agentInactive(agentId));
      }
      if (check.outcome === "denied") {
        return err(agentAccessDenied(agentId));
      }
      if (env.agentAccessCacheTtlMs > 0) {
        this.accessCache.set(accessCacheKey(principal.type, principal.id, agentId), check.snapshot);
      }
      return ok(check.snapshot);
    }

    const snapshot = await this.agentRepository.findAccessSnapshotById(agentId);
    if (!snapshot) {
      return err(agentNotFound(agentId));
    }

    if (snapshot.status !== "active") {
      return err(agentInactive(agentId));
    }

    const hasAccess =
      principal.type === "user"
        ? principal.role === "admin"
          ? true
          : await this.agentIdentityRepository.hasAccess(principal.id, agentId)
        : await this.clientAgentAccessRepository.hasAccess(principal.id, agentId);
    if (!hasAccess) {
      return err(agentAccessDenied(agentId));
    }

    if (env.agentAccessCacheTtlMs > 0) {
      this.accessCache.set(accessCacheKey(principal.type, principal.id, agentId), snapshot);
    }
    return ok(snapshot);
  }

  /**
   * Immediately removes a cached access grant for a specific principal+agent pair.
   * Call when client access is explicitly revoked so the eviction takes effect
   * before the TTL window expires.
   */
  invalidateAccessCache(principalType: string, principalId: string, agentId: string): void {
    this.accessCache.delete(accessCacheKey(principalType, principalId, agentId));
    if (principalType === "user") {
      this.bindRegisterCache?.delete(bindRegisterCacheKey(principalId, agentId));
    }
  }

  /**
   * Removes all cached access grants for a given agent (e.g. when the agent is
   * deactivated). O(n) over current cache size.
   */
  invalidateAccessCacheForAgent(agentId: string): void {
    this.accessCache.deleteWhere((key) => key.endsWith(`:${agentId}`));
    this.bindRegisterCache?.deleteWhere((key) => key.endsWith(`:${agentId}`));
  }

  /**
   * Removes all cached access grants for a given user (e.g. when the account is
   * blocked). O(n) over current cache size.
   */
  invalidateAccessCacheForUser(userId: string): void {
    this.accessCache.deleteWhere((key) => key.startsWith(`user:${userId}:`));
    this.bindRegisterCache?.deleteWhere((key) => key.startsWith(`bindReg:user:${userId}:`));
  }

  /**
   * Allows agent login when the agent is either missing from the catalog or active,
   * and is either unbound or already owned by the same user. Ownership is not created here.
   */
  async assertAgentLoginAllowed(userId: string, agentId: string): Promise<Result<void>> {
    return this.assertOwnershipEligible(userId, agentId);
  }

  /**
   * Confirms ownership when the agent completes agent:register after a valid agent-login.
   */
  async bindOwnershipOnRegister(userId: string, agentId: string): Promise<Result<void>> {
    const allowed = await this.assertOwnershipEligible(userId, agentId);
    if (!allowed.ok) {
      return allowed;
    }

    const cache = this.bindRegisterCache;
    const bindKey = bindRegisterCacheKey(userId, agentId);
    if (cache !== null && cache.get(bindKey) === true) {
      return ok(undefined);
    }

    // `agent_identities.agent_id` FK-references `agents`. Catalog rows are normally filled by
    // profile sync after register; ensure a stub exists before inserting identity.
    await this.ensureCatalogAgentExistsForIdentity(agentId, userId);

    const status = await this.agentIdentityRepository.bindIfUnbound(agentId, userId);
    if (status === "bound_to_other_user") {
      return err(agentAlreadyLinked(agentId));
    }

    if (cache !== null) {
      cache.set(bindKey, true);
    }

    return ok(undefined);
  }

  /**
   * Asserts that the agent exists and is active, without checking user binding.
   * Used for operations that only need to verify agent operability.
   */
  async assertAgentOperational(agentId: string): Promise<Result<Agent>> {
    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(agentNotFound(agentId));
    }

    if (agent.status !== "active") {
      return err(agentInactive(agentId));
    }

    return ok(agent);
  }

  private async ensureCatalogAgentExistsForIdentity(
    agentId: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.agentRepository.findById(agentId);
    if (existing) {
      return;
    }

    const stub = Agent.create({
      agentId,
      name: `Agent ${agentId}`,
      lastLoginUserId: userId,
      status: "active",
    });

    try {
      await this.agentRepository.save(stub);
    } catch (e) {
      const race = await this.agentRepository.findById(agentId);
      if (race) {
        return;
      }
      throw e;
    }
  }

  private async assertOwnershipEligible(userId: string, agentId: string): Promise<Result<void>> {
    const ownerUserId = await this.agentIdentityRepository.findOwnerUserId(agentId);
    if (ownerUserId !== null && ownerUserId !== userId) {
      return err(agentAlreadyLinked(agentId));
    }

    const agent = await this.agentRepository.findById(agentId);
    if (agent && agent.status !== "active") {
      return err(agentInactive(agentId));
    }

    return ok(undefined);
  }
}
