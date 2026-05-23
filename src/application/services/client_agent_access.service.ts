import {
  ClientAgentAccessRequest,
  type ClientAgentAccessRequestStatus,
} from "../../domain/entities/client_agent_access_request.entity";
import type { Agent } from "../../domain/entities/agent.entity";
import type { Client } from "../../domain/entities/client.entity";
import type { User } from "../../domain/entities/user.entity";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import type { IPendingClientAgentAccessWriter } from "../../domain/ports/pending_client_agent_access_writer.port";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type {
  AgentListFilter,
  IAgentRepository,
} from "../../domain/repositories/agent.repository.interface";
import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import type {
  ClientAgentAccessApprovalToken,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import type { IClientAgentAccessApprovalTxn } from "../../domain/ports/client_agent_access_approval_txn.port";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import { env } from "../../shared/config/env";
import {
  agentAccessDenied,
  conflict,
  forbidden,
  notFound,
  registrationTokenExpired,
  serviceUnavailable,
} from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { isExpired, parseExpiryToDate } from "../../shared/utils/date";
import { generateOpaqueClientAccessToken } from "../../shared/utils/client_access_token";
import { logger } from "../../shared/utils/logger";
import { Prisma } from "@prisma/client";
import {
  clientAgentAccessExpiredDecisionReason,
  clientAgentAccessRevokedByClientDecisionReason,
  clientAgentAccessRevokedByOwnerDecisionReason,
} from "./client_agent_access_decision_reasons";
import { enqueueClientAccessApprovalEmails } from "./registration_email_outbox.service";
import {
  recordClientAgentAccessPublicDecisionFinished,
  recordClientAgentAccessPublicDecisionStarted,
  type ClientAgentAccessPublicDecision,
  type ClientAgentAccessPublicDecisionOutcome,
} from "../../shared/metrics/client_agent_access_public_decision.metrics";
import { recordClientAgentAccessRequestPost } from "../../shared/metrics/client_agent_access_request.metrics";
import { recordSocketAuditEvent } from "./socket_audit.service";
import {
  revokeConsumerClientAccessSockets,
  grantConsumerClientAccessRooms,
} from "./consumer_socket_control_sink";
import {
  assertAgentEligibleForClientAccessGrant,
  assertClientEligibleForClientAccessGrant,
  isClientAccessRequestRetryEligible,
} from "../../domain/policies/client_agent_access_request.policy";
import { toSafeLogContext } from "../../shared/utils/safe_log_context";

/**
 * Audit event types for the per-(client, agent) bearer token storage.
 * Stored in `audit_events.event_type`. The token value itself is **never**
 * persisted — only metadata (length and whether a previous value existed).
 */
export const CLIENT_TOKEN_AUDIT_EVENT_TYPE_SET = "client_token.set";
export const CLIENT_TOKEN_AUDIT_EVENT_TYPE_CLEARED = "client_token.cleared";

interface ClientTokenAuditPayload {
  readonly len: number;
  readonly replacedExisting: boolean;
}

export interface ClientAgentAccessRequestRecord {
  readonly id: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly status: "pending" | "approved" | "rejected" | "expired" | "revoked";
  readonly requestedAt: Date;
  readonly decidedAt?: Date;
  readonly decisionReason?: string;
}

export interface ApprovedClientAgentListItem {
  readonly agent: Agent;
  readonly hasClientToken: boolean;
}

export interface ApprovedClientAgentListPage {
  readonly items: ApprovedClientAgentListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface ClientAgentAccessRequestListFilter {
  readonly status?: "pending" | "approved" | "rejected" | "expired" | "revoked";
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface OwnerClientAccessRequestListFilter extends ClientAgentAccessRequestListFilter {
  readonly agentId?: string;
  readonly clientId?: string;
}

export interface ClientAgentAccessRequestPage {
  readonly items: ClientAgentAccessRequestRecord[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface OwnerManagedAgentClientRecord {
  readonly clientId: string;
  readonly email: string;
  readonly name: string;
  readonly lastName: string;
  readonly status: "active" | "blocked";
  readonly approvedAt: Date;
}

export interface OwnerManagedAgentClientPage {
  readonly items: OwnerManagedAgentClientRecord[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface ClientAgentAccessRequestResult {
  /** Agent IDs for which a `pending` request was persisted and the owner was emailed in this call. */
  readonly requested: string[];
  readonly alreadyApproved: string[];
  /** Subset of `requested` where a prior `ClientAgentAccessRequest` row existed (reopen). */
  readonly reopened: string[];
  /** Subset of `requested` where no prior row existed for this client+agent pair. */
  readonly newRequests: string[];
  /** Client+agent pairs skipped: still `pending` and last `requestedAt` is within the debounce window. */
  readonly debounced: string[];
}

export interface ClientAgentAccessReviewSummary {
  readonly clientEmail: string;
  readonly clientName: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly requestStatus: ClientAgentAccessRequestStatus;
  readonly tokenStatus: "pending" | "expired";
}

export interface ClientAgentLiveProfileDeps {
  readonly isAgentOnline?: (agentId: string) => boolean;
  readonly refreshAgentProfile?: (agentId: string) => Promise<Agent>;
  /** Called after a client→agent access grant is removed (client-initiated or owner-initiated). */
  readonly onAccessRevoked?: (clientId: string, agentId: string) => void;
}

interface ClientAccessTokenDecisionOptions {
  readonly requestId?: string;
}

export class ClientAgentAccessService {
  private static readonly LIST_REFRESH_CONCURRENCY = 4;
  private static readonly LIST_REFRESH_RECENT_TTL_MS = 30_000;

  private readonly refreshInFlight = new Map<string, Promise<Agent>>();
  private readonly recentlyRefreshedAgents = new Map<
    string,
    { readonly agent: Agent; readonly refreshedAtMs: number }
  >();

  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
    private readonly clientRepository: IClientRepository,
    private readonly userRepository: IUserRepository,
    private readonly clientAgentAccessRepository: IClientAgentAccessRepository,
    private readonly clientAgentAccessRequestRepository: IClientAgentAccessRequestRepository,
    private readonly approvalTokenRepository: IClientAgentAccessApprovalTokenRepository,
    private readonly emailSender: IEmailSender,
    private readonly pendingAccessWriter: IPendingClientAgentAccessWriter,
    private readonly approvalTxn: IClientAgentAccessApprovalTxn,
    private readonly liveProfileDeps?: ClientAgentLiveProfileDeps,
  ) {}

  async listApprovedAgentIds(clientId: string): Promise<string[]> {
    return this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
  }

  /** Client IDs with approved access to this agent (for realtime fan-out). */
  async listApprovedClientIdsForAgent(agentId: string): Promise<string[]> {
    const accesses = await this.clientAgentAccessRepository.listByAgentId(agentId);
    return accesses.map((access) => access.clientId);
  }

  /** Active client IDs with approved access to this agent (for realtime fan-out). */
  async listActiveApprovedClientIdsForAgent(agentId: string): Promise<string[]> {
    if (this.clientAgentAccessRepository.listActiveClientIdsByAgentId !== undefined) {
      return this.clientAgentAccessRepository.listActiveClientIdsByAgentId(agentId);
    }
    const accesses = await this.clientAgentAccessRepository.listByAgentId(agentId);
    return this.clientRepository.findActiveIdsByIds(accesses.map((access) => access.clientId));
  }

  async listApprovedAgents(clientId: string): Promise<Agent[]> {
    const agentIds = await this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
    const agents = await this.agentRepository.findByIds(agentIds);
    const agentsById = new Map(agents.map((agent) => [agent.agentId, agent] as const));
    return agentIds
      .map((agentId) => agentsById.get(agentId))
      .filter((agent): agent is Agent => agent !== undefined);
  }

  async listApprovedAgentsPage(
    clientId: string,
    filter?: AgentListFilter,
    options?: { readonly refreshOnline?: boolean },
  ): Promise<ApprovedClientAgentListPage> {
    if (this.clientAgentAccessRepository.listApprovedAgentsPageByClient !== undefined) {
      const pageResult = await this.clientAgentAccessRepository.listApprovedAgentsPageByClient(
        clientId,
        filter,
      );
      if (options?.refreshOnline !== true) {
        return pageResult;
      }
      return {
        ...pageResult,
        items: await this.refreshApprovedAgentListItems(clientId, pageResult.items),
      };
    }

    const agentIds = await this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
    const pageResult = await this.agentRepository.findAll({
      ...(filter ?? {}),
      agentIds,
    });
    const pageAgents =
      options?.refreshOnline !== true
        ? pageResult.items
        : (
            await this.refreshApprovedAgentListItems(
              clientId,
              pageResult.items.map((agent) => ({ agent, hasClientToken: false })),
            )
          ).map((item) => item.agent);
    const tokenPresenceByAgent =
      await this.clientAgentAccessRepository.listClientTokenPresenceForClientIn(
        clientId,
        pageAgents.map((agent) => agent.agentId),
      );
    return {
      ...pageResult,
      items: pageAgents.map((agent) => ({
        agent,
        hasClientToken: tokenPresenceByAgent.get(agent.agentId) === true,
      })),
    };
  }

  async findApprovedAgent(clientId: string, agentId: string): Promise<Result<Agent>> {
    const hasAccess = await this.clientAgentAccessRepository.hasAccess(clientId, agentId);
    if (!hasAccess) {
      return err(agentAccessDenied(agentId));
    }

    const persistedAgent = await this.agentRepository.findById(agentId);
    if (!persistedAgent) {
      return err(notFound(`Agent ${agentId}`));
    }

    return ok(await this.resolvePreferredAgentSnapshot(clientId, agentId, persistedAgent));
  }

  /**
   * Bulk presence map: for each `agentId` in `agentIds`, returns whether the
   * client has stored a non-empty `client_token`. Used by the listing endpoint
   * to expose `hasClientToken` without leaking the actual token value.
   */
  async getClientTokenPresenceForAgents(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, boolean>> {
    return this.clientAgentAccessRepository.listClientTokenPresenceForClientIn(clientId, agentIds);
  }

  /** Convenience for single-agent detail endpoints (`findApprovedAgent` companion). */
  async hasClientTokenForAgent(clientId: string, agentId: string): Promise<boolean> {
    const access = await this.clientAgentAccessRepository.findByClientAndAgent(clientId, agentId);
    return access !== null && typeof access.clientToken === "string" && access.clientToken !== "";
  }

  async listRequests(clientId: string): Promise<ClientAgentAccessRequestRecord[]> {
    const requests = await this.clientAgentAccessRequestRepository.listByClientId(clientId);
    const agentsById = await this.loadAgentsById(requests.map((request) => request.agentId));
    return requests.map((request) =>
      this.toRequestRecord(
        Object.assign(
          request,
          agentsById.get(request.agentId)?.name !== undefined
            ? { agentName: agentsById.get(request.agentId)!.name }
            : {},
        ),
      ),
    );
  }

  async listRequestsPage(
    clientId: string,
    filter?: ClientAgentAccessRequestListFilter,
  ): Promise<ClientAgentAccessRequestPage> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);
    if (env.nodeEnv === "test" && filter?.search !== undefined && filter.search.trim() !== "") {
      const items = this.filterRequestRecords(await this.listRequests(clientId), filter);
      return this.paginateRequestRecords(items, page, pageSize);
    }

    const result = await this.clientAgentAccessRequestRepository.listByClientPage(clientId, {
      ...(filter?.status !== undefined ? { status: filter.status } : {}),
      ...(filter?.search !== undefined ? { search: filter.search } : {}),
      page,
      pageSize,
    });

    return {
      items: result.items.map((request) => this.toRequestRecord(request)),
      total: result.total,
      page,
      pageSize,
    };
  }

  async requestAccess(
    clientId: string,
    agentIds: string[],
  ): Promise<Result<ClientAgentAccessRequestResult>> {
    const client = await this.clientRepository.findById(clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    if (client.status !== "active") {
      return err(forbidden("Client account is not active"));
    }

    const uniqueAgentIds = [...new Set(agentIds)];
    const agents = await this.agentRepository.findByIds(uniqueAgentIds);
    const agentById = new Map(agents.map((a) => [a.agentId, a] as const));
    if (agents.length !== uniqueAgentIds.length) {
      const missingAgentId = uniqueAgentIds.find((id) => !agentById.has(id));
      return err(notFound(`Agent ${missingAgentId ?? ""}`.trim()));
    }

    const inactiveAgentId = uniqueAgentIds.find((id) => agentById.get(id)?.status !== "active");
    if (inactiveAgentId !== undefined) {
      return err(conflict(`Agent ${inactiveAgentId} is not active`));
    }

    const alreadyApproved = await this.clientAgentAccessRepository.listAccessAgentIdsForClientIn(
      clientId,
      uniqueAgentIds,
    );
    const workAgentIds = uniqueAgentIds.filter((id) => !alreadyApproved.includes(id));

    if (workAgentIds.length === 0) {
      recordClientAgentAccessRequestPost({
        requestedCount: 0,
        newCount: 0,
        reopenedCount: 0,
        debouncedCount: 0,
        alreadyApprovedCount: alreadyApproved.length,
      });
      return ok({
        requested: [],
        alreadyApproved,
        newRequests: [],
        reopened: [],
        debounced: [],
      });
    }

    const ownersByAgent =
      await this.agentIdentityRepository.findOwnerUserIdsByAgentIds(workAgentIds);
    const missingOwnerAgentId = workAgentIds.find((id) => !ownersByAgent.has(id));
    if (missingOwnerAgentId !== undefined) {
      return err(conflict(`Agent ${missingOwnerAgentId} has no responsible user`));
    }

    const uniqueOwnerIds = [...new Set(workAgentIds.map((id) => ownersByAgent.get(id)!))];
    const owners = await this.userRepository.findByIds(uniqueOwnerIds);
    const ownerById = new Map(owners.map((u) => [u.id, u] as const));
    if (owners.length !== uniqueOwnerIds.length) {
      return err(notFound("Owner user"));
    }

    const requestsByAgent = await this.clientAgentAccessRequestRepository.findByClientAndAgents(
      clientId,
      workAgentIds,
    );

    const debounced: string[] = [];
    const newRequestIds: string[] = [];
    const reopenedIds: string[] = [];
    const debounceMs = env.clientAgentAccessRequestEmailDebounceMs;

    type PendingRow = {
      readonly request: ClientAgentAccessRequest;
      readonly token: ClientAgentAccessApprovalToken;
      readonly owner: User;
      readonly agentId: string;
    };
    const pendingRows: PendingRow[] = [];

    for (const agentId of workAgentIds) {
      const ownerUserId = ownersByAgent.get(agentId)!;
      const owner = ownerById.get(ownerUserId);
      if (!owner) {
        return err(notFound("Owner user"));
      }

      const existing = requestsByAgent.get(agentId);
      if (existing?.status === "pending" && debounceMs > 0) {
        const elapsed = Date.now() - existing.requestedAt.getTime();
        if (elapsed >= 0 && elapsed < debounceMs) {
          debounced.push(agentId);
          continue;
        }
      }

      const maxRetries = env.clientAgentAccessMaxRetries;
      if (existing && maxRetries > 0 && existing.retryCount >= maxRetries) {
        return err(
          conflict(
            `Maximum retry attempts (${maxRetries}) reached for agent ${agentId}. Contact the agent owner.`,
          ),
        );
      }

      let request: ClientAgentAccessRequest;
      if (existing) {
        reopenedIds.push(agentId);
        const { decidedAt: _decidedAt, decisionReason: _decisionReason, ...baseRequest } = existing;
        request = new ClientAgentAccessRequest({
          ...baseRequest,
          status: "pending",
          retryCount: existing.retryCount + 1,
          requestedAt: new Date(),
          updatedAt: new Date(),
        });
      } else {
        newRequestIds.push(agentId);
        request = ClientAgentAccessRequest.create({
          clientId,
          agentId,
          retryCount: 0,
        });
      }

      const token = this.newApprovalToken(request.id);
      pendingRows.push({ request, token, owner, agentId });
    }

    if (pendingRows.length === 0) {
      recordClientAgentAccessRequestPost({
        requestedCount: 0,
        newCount: 0,
        reopenedCount: 0,
        debouncedCount: debounced.length,
        alreadyApprovedCount: alreadyApproved.length,
      });
      logger.info("client_agent_access_request_post", {
        clientId,
        requestedCount: 0,
        debouncedCount: debounced.length,
        alreadyApprovedCount: alreadyApproved.length,
      });
      return ok({
        requested: [],
        alreadyApproved,
        newRequests: [],
        reopened: [],
        debounced,
      });
    }

    await this.pendingAccessWriter.writePendingRequests(
      pendingRows.map((row) => ({ request: row.request, token: row.token })),
    );

    const emailInputs = pendingRows.map((row) => ({
      ownerEmail: row.owner.email,
      clientEmail: client.email,
      clientName: client.name,
      clientLastName: client.lastName,
      agentId: row.agentId,
      approvalToken: row.token.id,
    }));
    const queued = await enqueueClientAccessApprovalEmails(emailInputs);
    if (!queued) {
      await this.sendClientAccessRequestEmails(emailInputs);
    }

    const requested = pendingRows.map((row) => row.agentId);
    const newRequests = newRequestIds.filter((id) => requested.includes(id));
    const reopened = reopenedIds.filter((id) => requested.includes(id));

    recordClientAgentAccessRequestPost({
      requestedCount: requested.length,
      newCount: newRequests.length,
      reopenedCount: reopened.length,
      debouncedCount: debounced.length,
      alreadyApprovedCount: alreadyApproved.length,
    });

    logger.info("client_agent_access_request_post", {
      clientId,
      requestedCount: requested.length,
      newRequests: newRequests.length,
      reopenedCount: reopened.length,
      debouncedCount: debounced.length,
      alreadyApprovedCount: alreadyApproved.length,
    });

    return ok({
      requested,
      alreadyApproved,
      newRequests,
      reopened,
      debounced,
    });
  }

  async retryRequestByClient(
    clientId: string,
    requestId: string,
  ): Promise<Result<ClientAgentAccessRequestResult>> {
    const request = await this.clientAgentAccessRequestRepository.findById(requestId);
    if (!request || request.clientId !== clientId) {
      return err(notFound("Access request"));
    }

    if (request.status === "approved") {
      const hasAccess = await this.clientAgentAccessRepository.hasAccess(clientId, request.agentId);
      if (hasAccess) {
        return ok({
          requested: [],
          alreadyApproved: [request.agentId],
          newRequests: [],
          reopened: [],
          debounced: [],
        });
      }
      // Approved but the access row was removed (e.g. revoked by owner after status was set to
      // "approved"). Treat as eligible so the client can re-request without a 409.
    }

    if (
      request.status !== "pending" &&
      request.status !== "approved" &&
      !isClientAccessRequestRetryEligible(request.status)
    ) {
      return err(conflict("Access request cannot be retried from its current status"));
    }

    return this.requestAccess(clientId, [request.agentId]);
  }

  async getReviewSummaryByToken(tokenId: string): Promise<ClientAgentAccessReviewSummary | null> {
    const summary = await this.approvalTokenRepository.findReviewSummaryById(tokenId);
    if (summary) {
      return {
        clientEmail: summary.clientEmail,
        clientName: summary.clientName,
        agentId: summary.agentId,
        ...(summary.agentName !== undefined ? { agentName: summary.agentName } : {}),
        requestStatus: summary.requestStatus,
        tokenStatus: isExpired(summary.expiresAt) ? "expired" : "pending",
      };
    }

    const token = await this.approvalTokenRepository.findById(tokenId);
    if (!token) {
      return null;
    }

    const request = await this.clientAgentAccessRequestRepository.findById(token.requestId);
    if (!request) {
      return null;
    }

    const client = await this.clientRepository.findById(request.clientId);
    if (!client) {
      return null;
    }

    const agent = await this.agentRepository.findById(request.agentId);
    return {
      clientEmail: client.email,
      clientName: `${client.name} ${client.lastName}`.trim(),
      agentId: request.agentId,
      ...(agent?.name !== undefined ? { agentName: agent.name } : {}),
      requestStatus: request.status,
      tokenStatus: isExpired(token.expiresAt) ? "expired" : "pending",
    };
  }

  async removeApprovedAccess(clientId: string, agentIds: string[]): Promise<Result<void>> {
    const uniqueAgentIds = [...new Set(agentIds)];
    const approvedAgentIds = await this.clientAgentAccessRepository.listAccessAgentIdsForClientIn(
      clientId,
      uniqueAgentIds,
    );
    await this.clientAgentAccessRepository.removeAgentIds(clientId, uniqueAgentIds);
    for (const agentId of uniqueAgentIds) {
      this.liveProfileDeps?.onAccessRevoked?.(clientId, agentId);
      const request = await this.clientAgentAccessRequestRepository.findByClientAndAgent(
        clientId,
        agentId,
      );
      if (request?.status === "approved") {
        await this.clientAgentAccessRequestRepository.setStatus(request.id, "revoked", {
          reason: clientAgentAccessRevokedByClientDecisionReason,
        });
      }
      if (!approvedAgentIds.includes(agentId)) {
        continue;
      }
      await revokeConsumerClientAccessSockets({
        clientId,
        agentId,
        reason: "client_access_revoked",
      });
    }
    return ok(undefined);
  }

  async approveByToken(
    tokenId: string,
    options?: ClientAccessTokenDecisionOptions,
  ): Promise<Result<{ clientEmail: string; agentId: string }>> {
    const startedAtMs = Date.now();
    const baseLog = {
      requestId: options?.requestId,
      tokenPrefix: this.tokenPrefix(tokenId),
      decision: "approve",
    };
    recordClientAgentAccessPublicDecisionStarted("approve");
    this.logClientAccessDecision("client_access_token_decision_started", {
      ...baseLog,
      tokenStatus: "lookup",
    });
    try {
      const token = await this.approvalTokenRepository.findById(tokenId);
      if (!token) {
        this.recordPublicDecisionOutcome("approve", "invalid_token", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          tokenStatus: "missing",
          result: "invalid_token",
        });
        return err(notFound("Approval link is invalid or was already used"));
      }
      const request = await this.clientAgentAccessRequestRepository.findById(token.requestId);
      if (!request) {
        await this.approvalTokenRepository.deleteById(tokenId);
        this.recordPublicDecisionOutcome("approve", "request_missing", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: token.requestId,
          tokenStatus: "orphaned",
          result: "request_missing",
        });
        return err(notFound("Access request"));
      }
      if (isExpired(token.expiresAt)) {
        await this.clientAgentAccessRequestRepository.setStatus(request.id, "expired", {
          reason: clientAgentAccessExpiredDecisionReason,
        });
        await this.approvalTokenRepository.deleteById(tokenId);
        this.recordPublicDecisionOutcome("approve", "expired", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "expired",
          result: "expired",
        });
        return err(registrationTokenExpired("This approval link has expired"));
      }
      if (request.status !== "pending") {
        await this.approvalTokenRepository.deleteById(tokenId);
        this.recordPublicDecisionOutcome("approve", "already_processed", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
          result: "already_processed",
        });
        return err(conflict("Access request already processed"));
      }

      const client = await this.clientRepository.findById(request.clientId);
      if (!client) {
        this.recordPublicDecisionOutcome("approve", "client_missing", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
          result: "client_missing",
        });
        return err(notFound("Client"));
      }
      const eligible = assertClientEligibleForClientAccessGrant(client);
      if (!eligible.ok) {
        this.recordPublicDecisionOutcome("approve", "client_ineligible", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
          result: "client_ineligible",
          errorCode: eligible.error.code,
        });
        return eligible;
      }

      const agent = await this.agentRepository.findById(request.agentId);
      if (!agent) {
        this.recordPublicDecisionOutcome("approve", "agent_missing", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
          result: "agent_missing",
        });
        return err(notFound(`Agent ${request.agentId}`));
      }
      const agentEligible = assertAgentEligibleForClientAccessGrant(agent);
      if (!agentEligible.ok) {
        this.recordPublicDecisionOutcome("approve", "agent_ineligible", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
          result: "agent_ineligible",
          errorCode: agentEligible.error.code,
        });
        return agentEligible;
      }

      const approvedAt = new Date();
      let granted: boolean;
      try {
        granted = await this.approvalTxn.approvePendingAndGrantAccess({
          requestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          approvedAt,
          consumeTokenId: tokenId,
        });
      } catch (error: unknown) {
        this.logAccessTxnFailure("approve_by_token", error, {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
        });
        this.recordPublicDecisionOutcome("approve", "service_unavailable", startedAtMs);
        return err(
          serviceUnavailable(
            "N\u00e3o foi poss\u00edvel concluir a aprova\u00e7\u00e3o. Tente novamente em instantes.",
          ),
        );
      }
      if (!granted) {
        this.recordPublicDecisionOutcome("approve", "already_processed", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
          result: "already_processed",
        });
        return err(conflict("Access request already processed"));
      }

      await this.notifyClientAccessApproved(client.email, request.agentId);
      await grantConsumerClientAccessRooms({
        clientId: request.clientId,
        agentId: request.agentId,
      });
      this.recordPublicDecisionOutcome("approve", "approved", startedAtMs);
      this.logClientAccessDecision("client_access_token_decision_finished", {
        ...baseLog,
        accessRequestId: request.id,
        clientId: request.clientId,
        agentId: request.agentId,
        requestStatus: "approved",
        tokenStatus: "consumed",
        result: "approved",
      });
      return ok({ clientEmail: client.email, agentId: request.agentId });
    } catch (error: unknown) {
      this.logAccessTxnFailure("approve_by_token_unhandled", error, baseLog);
      this.recordPublicDecisionOutcome("approve", "service_unavailable", startedAtMs);
      return err(
        serviceUnavailable(
          "N\u00e3o foi poss\u00edvel concluir a aprova\u00e7\u00e3o. Tente novamente em instantes.",
        ),
      );
    }
  }

  async rejectByToken(
    tokenId: string,
    reason?: string,
    options?: ClientAccessTokenDecisionOptions,
  ): Promise<Result<{ clientEmail: string; agentId: string }>> {
    const startedAtMs = Date.now();
    const baseLog = {
      requestId: options?.requestId,
      tokenPrefix: this.tokenPrefix(tokenId),
      decision: "reject",
    };
    recordClientAgentAccessPublicDecisionStarted("reject");
    this.logClientAccessDecision("client_access_token_decision_started", {
      ...baseLog,
      tokenStatus: "lookup",
    });
    try {
      const token = await this.approvalTokenRepository.findById(tokenId);
      if (!token) {
        this.recordPublicDecisionOutcome("reject", "invalid_token", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          tokenStatus: "missing",
          result: "invalid_token",
        });
        return err(notFound("Rejection link is invalid or was already used"));
      }
      const request = await this.clientAgentAccessRequestRepository.findById(token.requestId);
      if (!request) {
        await this.approvalTokenRepository.deleteById(tokenId);
        this.recordPublicDecisionOutcome("reject", "request_missing", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: token.requestId,
          tokenStatus: "orphaned",
          result: "request_missing",
        });
        return err(notFound("Access request"));
      }
      if (isExpired(token.expiresAt)) {
        await this.clientAgentAccessRequestRepository.setStatus(request.id, "expired", {
          reason: clientAgentAccessExpiredDecisionReason,
        });
        await this.approvalTokenRepository.deleteById(tokenId);
        this.recordPublicDecisionOutcome("reject", "expired", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "expired",
          result: "expired",
        });
        return err(registrationTokenExpired("This rejection link has expired"));
      }
      if (request.status !== "pending") {
        await this.approvalTokenRepository.deleteById(tokenId);
        this.recordPublicDecisionOutcome("reject", "already_processed", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
          result: "already_processed",
        });
        return err(conflict("Access request already processed"));
      }

      const decidedAt = new Date();
      let rejected: boolean;
      try {
        rejected = await this.approvalTxn.rejectPendingAndConsumeToken({
          requestId: request.id,
          decidedAt,
          ...(reason !== undefined ? { reason } : {}),
          consumeTokenId: tokenId,
        });
      } catch (error: unknown) {
        this.logAccessTxnFailure("reject_by_token", error, {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
        });
        this.recordPublicDecisionOutcome("reject", "service_unavailable", startedAtMs);
        return err(
          serviceUnavailable(
            "N\u00e3o foi poss\u00edvel concluir a recusa. Tente novamente em instantes.",
          ),
        );
      }
      if (!rejected) {
        await this.approvalTokenRepository.deleteById(tokenId);
        this.recordPublicDecisionOutcome("reject", "already_processed", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: request.status,
          tokenStatus: "pending",
          result: "already_processed",
        });
        return err(conflict("Access request already processed"));
      }

      const client = await this.clientRepository.findById(request.clientId);
      if (!client) {
        this.recordPublicDecisionOutcome("reject", "rejected_client_missing", startedAtMs);
        this.logClientAccessDecision("client_access_token_decision_finished", {
          ...baseLog,
          accessRequestId: request.id,
          clientId: request.clientId,
          agentId: request.agentId,
          requestStatus: "rejected",
          tokenStatus: "consumed",
          result: "rejected_client_missing",
        });
        return ok({ clientEmail: "", agentId: request.agentId });
      }
      await this.notifyClientAccessRejected(client.email, request.agentId, reason);
      this.recordPublicDecisionOutcome("reject", "rejected", startedAtMs);
      this.logClientAccessDecision("client_access_token_decision_finished", {
        ...baseLog,
        accessRequestId: request.id,
        clientId: request.clientId,
        agentId: request.agentId,
        requestStatus: "rejected",
        tokenStatus: "consumed",
        result: "rejected",
      });
      return ok({ clientEmail: client.email, agentId: request.agentId });
    } catch (error: unknown) {
      this.logAccessTxnFailure("reject_by_token_unhandled", error, baseLog);
      this.recordPublicDecisionOutcome("reject", "service_unavailable", startedAtMs);
      return err(
        serviceUnavailable(
          "N\u00e3o foi poss\u00edvel concluir a recusa. Tente novamente em instantes.",
        ),
      );
    }
  }

  async getRequestStatusByToken(tokenId: string): Promise<Result<{ status: string }>> {
    const token = await this.approvalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Access token"));
    }
    if (isExpired(token.expiresAt)) {
      return ok({ status: "expired" });
    }
    const request = await this.clientAgentAccessRequestRepository.findById(token.requestId);
    if (!request) {
      return err(notFound("Access request"));
    }
    return ok({ status: request.status });
  }

  async listRequestsByOwnerPage(
    ownerUserId: string,
    filter?: OwnerClientAccessRequestListFilter,
  ): Promise<Result<ClientAgentAccessRequestPage>> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);
    const result = await this.clientAgentAccessRequestRepository.listByOwnerPage(ownerUserId, {
      ...(filter?.status !== undefined ? { status: filter.status } : {}),
      ...(filter?.search !== undefined ? { search: filter.search } : {}),
      ...(filter?.agentId !== undefined ? { agentId: filter.agentId } : {}),
      ...(filter?.clientId !== undefined ? { clientId: filter.clientId } : {}),
      page,
      pageSize,
    });
    return ok({
      items: result.items.map((item) => this.toRequestRecord(item)),
      total: result.total,
      page,
      pageSize,
    });
  }

  async approveByOwner(
    ownerUserId: string,
    requestId: string,
  ): Promise<Result<{ clientEmail: string; agentId: string }>> {
    const request = await this.clientAgentAccessRequestRepository.findById(requestId);
    if (!request) {
      return err(notFound("Access request"));
    }
    const ownerResult = await this.assertAgentOwnership(ownerUserId, request.agentId);
    if (!ownerResult.ok) {
      return ownerResult;
    }
    if (request.status !== "pending") {
      return err(conflict("Access request already processed"));
    }

    const client = await this.clientRepository.findById(request.clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    const eligible = assertClientEligibleForClientAccessGrant(client);
    if (!eligible.ok) {
      return eligible;
    }

    const agent = await this.agentRepository.findById(request.agentId);
    if (!agent) {
      return err(notFound(`Agent ${request.agentId}`));
    }
    const agentEligible = assertAgentEligibleForClientAccessGrant(agent);
    if (!agentEligible.ok) {
      return agentEligible;
    }

    const approvedAt = new Date();
    let granted: boolean;
    try {
      granted = await this.approvalTxn.approvePendingAndGrantAccess({
        requestId: request.id,
        clientId: request.clientId,
        agentId: request.agentId,
        approvedAt,
      });
    } catch (error: unknown) {
      this.logAccessTxnFailure("approve_by_owner", error);
      return err(
        serviceUnavailable("Não foi possível concluir a aprovação. Tente novamente em instantes."),
      );
    }
    if (!granted) {
      return err(conflict("Access request already processed"));
    }

    await this.notifyClientAccessApproved(client.email, request.agentId);
    await grantConsumerClientAccessRooms({
      clientId: request.clientId,
      agentId: request.agentId,
    });
    return ok({ clientEmail: client.email, agentId: request.agentId });
  }

  async rejectByOwner(
    ownerUserId: string,
    requestId: string,
    reason?: string,
  ): Promise<Result<{ clientEmail: string; agentId: string }>> {
    const request = await this.clientAgentAccessRequestRepository.findById(requestId);
    if (!request) {
      return err(notFound("Access request"));
    }
    const ownerResult = await this.assertAgentOwnership(ownerUserId, request.agentId);
    if (!ownerResult.ok) {
      return ownerResult;
    }
    if (request.status !== "pending") {
      return err(conflict("Access request already processed"));
    }

    const decidedAt = new Date();
    let rejected: boolean;
    try {
      rejected = await this.approvalTxn.rejectPendingAndConsumeToken({
        requestId: request.id,
        decidedAt,
        ...(reason !== undefined ? { reason } : {}),
      });
    } catch (error: unknown) {
      this.logAccessTxnFailure("reject_by_owner", error);
      return err(
        serviceUnavailable("Não foi possível concluir a recusa. Tente novamente em instantes."),
      );
    }
    if (!rejected) {
      return err(conflict("Access request already processed"));
    }

    const client = await this.clientRepository.findById(request.clientId);
    if (!client) {
      logger.warn("client_access_reject_owner_missing_client", { requestId: request.id });
      return ok({ clientEmail: "", agentId: request.agentId });
    }
    await this.notifyClientAccessRejected(client.email, request.agentId, reason);
    return ok({ clientEmail: client.email, agentId: request.agentId });
  }

  async listAgentClientsByOwnerPage(
    ownerUserId: string,
    agentId: string,
    filter?: {
      readonly status?: "active" | "blocked";
      readonly search?: string;
      readonly page?: number;
      readonly pageSize?: number;
    },
  ): Promise<Result<OwnerManagedAgentClientPage>> {
    const ownerResult = await this.assertAgentOwnership(ownerUserId, agentId);
    if (!ownerResult.ok) {
      return ownerResult;
    }
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);
    if (this.clientAgentAccessRepository.listOwnerManagedClientsPageByAgentId !== undefined) {
      const result = await this.clientAgentAccessRepository.listOwnerManagedClientsPageByAgentId(
        agentId,
        filter,
      );
      return ok(result);
    }
    const accesses = await this.clientAgentAccessRepository.listByAgentId(agentId);
    const clientsById = await this.loadClientsById(accesses.map((access) => access.clientId));
    let items: OwnerManagedAgentClientRecord[] = accesses
      .map((access) => {
        const client = clientsById.get(access.clientId);
        if (!client) {
          return null;
        }
        return {
          clientId: client.id,
          email: client.email,
          name: client.name,
          lastName: client.lastName,
          status: client.status,
          approvedAt: access.approvedAt,
        };
      })
      .filter((item): item is OwnerManagedAgentClientRecord => item !== null);

    if (filter?.status !== undefined) {
      items = items.filter((item) => item.status === filter.status);
    }
    if (filter?.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      items = items.filter(
        (item) =>
          item.clientId.toLowerCase().includes(query) ||
          item.email.toLowerCase().includes(query) ||
          item.name.toLowerCase().includes(query) ||
          item.lastName.toLowerCase().includes(query),
      );
    }

    items = items.sort(
      (left, right) =>
        left.approvedAt.getTime() - right.approvedAt.getTime() ||
        left.clientId.localeCompare(right.clientId),
    );

    const total = items.length;
    const start = (page - 1) * pageSize;
    return ok({
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    });
  }

  /**
   * Reads the per-(client, agent) bearer token stored at access-approval time
   * (or set later via {@link setClientTokenForAgent}). Only returns a value
   * when the client currently has approved access to the agent.
   *
   * Returns `null` when access exists but no token is stored yet.
   */
  async getClientTokenForAgent(
    clientId: string,
    agentId: string,
  ): Promise<Result<{ clientToken: string | null }>> {
    const access = await this.clientAgentAccessRepository.findByClientAndAgent(clientId, agentId);
    if (!access) {
      return err(agentAccessDenied(agentId));
    }
    return ok({ clientToken: access.clientToken });
  }

  /**
   * Stores (or clears) the per-(client, agent) bearer token. The client must
   * already have approved access to the agent — this method does NOT create
   * the access row.
   *
   * - `clientToken: string` — replace stored token.
   * - `clientToken: null`  — clear the stored token.
   *
   * Emits an `audit_events` row (`client_token.set` / `client_token.cleared`)
   * with metadata only (length + whether a previous value existed). The token
   * value itself is **never** persisted in the audit trail.
   *
   * Returns the value the client should now see.
   */
  async setClientTokenForAgent(
    clientId: string,
    agentId: string,
    clientToken: string | null,
  ): Promise<Result<{ clientToken: string | null }>> {
    const existing = await this.clientAgentAccessRepository.findByClientAndAgent(clientId, agentId);
    if (!existing) {
      return err(agentAccessDenied(agentId));
    }

    const updated = await this.clientAgentAccessRepository.setClientToken(
      clientId,
      agentId,
      clientToken,
    );
    if (!updated) {
      // Race: row deleted between the read and the write — treat as if access
      // had never existed.
      return err(agentAccessDenied(agentId));
    }

    const replacedExisting =
      typeof existing.clientToken === "string" && existing.clientToken !== "";
    void this.recordClientTokenAudit({
      clientId,
      agentId,
      eventType:
        clientToken === null
          ? CLIENT_TOKEN_AUDIT_EVENT_TYPE_CLEARED
          : CLIENT_TOKEN_AUDIT_EVENT_TYPE_SET,
      payload: {
        len: clientToken ? clientToken.length : 0,
        replacedExisting,
      },
    });

    return ok({ clientToken });
  }

  private async recordClientTokenAudit(input: {
    readonly clientId: string;
    readonly agentId: string;
    readonly eventType: string;
    readonly payload: ClientTokenAuditPayload;
  }): Promise<void> {
    try {
      await recordSocketAuditEvent({
        eventType: input.eventType,
        // `actor_user_id` is the principal column on `audit_events`; here it
        // carries the client id (principal_type=client) so queries can join
        // by `clients.id` when the actor was a client.
        actorUserId: input.clientId,
        actorRole: "client",
        direction: "control",
        agentId: input.agentId,
        payload: input.payload,
      });
    } catch (error) {
      // Audit failures must never break the user-facing operation.
      logger.warn("client_token_audit_record_failed", {
        clientId: input.clientId,
        agentId: input.agentId,
        eventType: input.eventType,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async revokeAccessByOwner(
    ownerUserId: string,
    agentId: string,
    clientId: string,
  ): Promise<Result<void>> {
    const ownerResult = await this.assertAgentOwnership(ownerUserId, agentId);
    if (!ownerResult.ok) {
      return ownerResult;
    }
    const client = await this.clientRepository.findById(clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    await this.clientAgentAccessRepository.removeAccess(clientId, agentId);
    this.liveProfileDeps?.onAccessRevoked?.(clientId, agentId);
    const request = await this.clientAgentAccessRequestRepository.findByClientAndAgent(
      clientId,
      agentId,
    );
    if (request?.status === "approved") {
      await this.clientAgentAccessRequestRepository.setStatus(request.id, "revoked", {
        reason: clientAgentAccessRevokedByOwnerDecisionReason,
      });
    }
    await revokeConsumerClientAccessSockets({
      clientId,
      agentId,
      reason: "client_access_revoked",
    });
    return ok(undefined);
  }

  private newApprovalToken(requestId: string): ClientAgentAccessApprovalToken {
    return {
      id: generateOpaqueClientAccessToken(),
      requestId,
      expiresAt: parseExpiryToDate(env.approvalTokenExpiresIn),
      createdAt: new Date(),
    };
  }

  private async refreshApprovedAgentListItems(
    clientId: string,
    items: readonly ApprovedClientAgentListItem[],
  ): Promise<ApprovedClientAgentListItem[]> {
    if (items.length === 0) {
      return [];
    }

    const refreshedByAgentId = new Map<string, Agent>();
    const candidates = items.filter(
      (item) => this.liveProfileDeps?.isAgentOnline?.(item.agent.agentId) === true,
    );

    let nextIndex = 0;
    const concurrency = Math.max(
      1,
      Math.min(ClientAgentAccessService.LIST_REFRESH_CONCURRENCY, candidates.length),
    );
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (nextIndex < candidates.length) {
          const item = candidates[nextIndex];
          nextIndex += 1;
          if (!item) {
            continue;
          }
          const refreshed = await this.resolvePreferredAgentSnapshotWithDedup(
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

  private async resolvePreferredAgentSnapshotWithDedup(
    clientId: string,
    agentId: string,
    persistedAgent: Agent,
  ): Promise<Agent> {
    const nowMs = Date.now();
    const recent = this.recentlyRefreshedAgents.get(agentId);
    if (
      recent !== undefined &&
      nowMs - recent.refreshedAtMs < ClientAgentAccessService.LIST_REFRESH_RECENT_TTL_MS
    ) {
      return recent.agent;
    }

    const inFlight = this.refreshInFlight.get(agentId);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const refreshPromise = this.resolvePreferredAgentSnapshot(clientId, agentId, persistedAgent)
      .then((agent) => {
        this.recentlyRefreshedAgents.set(agentId, { agent, refreshedAtMs: Date.now() });
        return agent;
      })
      .finally(() => {
        this.refreshInFlight.delete(agentId);
      });
    this.refreshInFlight.set(agentId, refreshPromise);
    return refreshPromise;
  }

  private async resolvePreferredAgentSnapshot(
    clientId: string,
    agentId: string,
    persistedAgent: Agent,
  ): Promise<Agent> {
    if (
      this.liveProfileDeps?.refreshAgentProfile === undefined ||
      this.liveProfileDeps.isAgentOnline?.(agentId) !== true
    ) {
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

  private async loadAgentsById(agentIds: readonly string[]): Promise<Map<string, Agent>> {
    const uniqueAgentIds = [...new Set(agentIds)];
    const agents = await this.agentRepository.findByIds(uniqueAgentIds);
    return new Map(agents.map((agent) => [agent.agentId, agent] as const));
  }

  private async loadClientsById(clientIds: readonly string[]): Promise<Map<string, Client>> {
    const uniqueClientIds = [...new Set(clientIds)];
    const clients = await Promise.all(
      uniqueClientIds.map((clientId) => this.clientRepository.findById(clientId)),
    );
    const map = new Map<string, Client>();
    for (const client of clients) {
      if (client) {
        map.set(client.id, client);
      }
    }
    return map;
  }

  private toRequestRecord(
    request: ClientAgentAccessRequest & {
      readonly agentName?: string;
    },
  ): ClientAgentAccessRequestRecord {
    return {
      id: request.id,
      clientId: request.clientId,
      agentId: request.agentId,
      ...(request.agentName !== undefined ? { agentName: request.agentName } : {}),
      status: request.status,
      requestedAt: request.requestedAt,
      ...(request.decidedAt !== undefined ? { decidedAt: request.decidedAt } : {}),
      ...(request.decisionReason !== undefined ? { decisionReason: request.decisionReason } : {}),
    };
  }

  private filterRequestRecords(
    items: ClientAgentAccessRequestRecord[],
    filter?: ClientAgentAccessRequestListFilter,
  ): ClientAgentAccessRequestRecord[] {
    let filtered = items;
    if (filter?.status !== undefined) {
      filtered = filtered.filter((request) => request.status === filter.status);
    }
    if (filter?.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      filtered = filtered.filter(
        (request) =>
          request.agentId.toLowerCase().includes(query) ||
          (request.agentName?.toLowerCase().includes(query) ?? false),
      );
    }
    return filtered;
  }

  private paginateRequestRecords(
    items: ClientAgentAccessRequestRecord[],
    page: number,
    pageSize: number,
  ): ClientAgentAccessRequestPage {
    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }

  private logAccessTxnFailure(
    operation: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): void {
    const base = {
      operation,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      ...(context ?? {}),
    };
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      this.safeLog("error", "client_agent_access_txn_prisma_error", {
        ...base,
        prismaCode: error.code,
        meta: error.meta,
      });
      return;
    }
    this.safeLog("error", "client_agent_access_txn_failed", base);
  }

  private async sendClientAccessRequestEmails(
    inputs: ReadonlyArray<{
      readonly ownerEmail: string;
      readonly clientEmail: string;
      readonly clientName: string;
      readonly clientLastName: string;
      readonly agentId: string;
      readonly approvalToken: string;
    }>,
  ): Promise<void> {
    const concurrency = Math.max(1, Math.min(4, inputs.length));
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (nextIndex < inputs.length) {
          const input = inputs[nextIndex];
          nextIndex += 1;
          if (input) {
            await this.emailSender.sendClientAccessRequestToOwner(input);
          }
        }
      }),
    );
  }

  private async assertAgentOwnership(ownerUserId: string, agentId: string): Promise<Result<void>> {
    const owner = await this.agentIdentityRepository.findOwnerUserId(agentId);
    if (owner === null) {
      return err(notFound(`Agent ${agentId}`));
    }
    if (owner !== ownerUserId) {
      return err(agentAccessDenied(agentId));
    }
    return ok(undefined);
  }

  private async notifyClientAccessApproved(clientEmail: string, agentId: string): Promise<void> {
    try {
      await this.emailSender.sendClientAccessApproved({
        clientEmail,
        agentId,
      });
    } catch (error: unknown) {
      logger.error("client_access_approved_email_failed", {
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyClientAccessRejected(
    clientEmail: string,
    agentId: string,
    reason?: string,
  ): Promise<void> {
    try {
      await this.emailSender.sendClientAccessRejected({
        clientEmail,
        agentId,
        ...(reason ? { reason } : {}),
      });
    } catch (error: unknown) {
      logger.error("client_access_rejected_email_failed", {
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private tokenPrefix(tokenId: string): string {
    return tokenId.slice(0, 8);
  }

  private recordPublicDecisionOutcome(
    decision: ClientAgentAccessPublicDecision,
    outcome: ClientAgentAccessPublicDecisionOutcome,
    startedAtMs: number,
  ): void {
    recordClientAgentAccessPublicDecisionFinished({
      decision,
      outcome,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });
  }

  private logClientAccessDecision(event: string, context: Record<string, unknown>): void {
    this.safeLog("info", event, context);
  }

  private safeLog(
    level: "info" | "warn" | "error",
    event: string,
    context: Record<string, unknown>,
  ): void {
    try {
      const safeContext = toSafeLogContext(context);
      if (level === "info") {
        logger.info(event, safeContext);
        return;
      }
      if (level === "warn") {
        logger.warn(event, safeContext);
        return;
      }
      logger.error(event, safeContext);
    } catch (logError: unknown) {
      logger.error("client_access_safe_log_failed", {
        event,
        message: logError instanceof Error ? logError.message : String(logError),
      });
    }
  }

  private async filterRequestsByOwner(
    ownerUserId: string,
    requests: readonly ClientAgentAccessRequest[],
  ): Promise<ClientAgentAccessRequest[]> {
    const agentIds = [...new Set(requests.map((r) => r.agentId))];
    const ownersByAgent = await this.agentIdentityRepository.findOwnerUserIdsByAgentIds(agentIds);
    return requests.filter((request) => ownersByAgent.get(request.agentId) === ownerUserId);
  }
}
