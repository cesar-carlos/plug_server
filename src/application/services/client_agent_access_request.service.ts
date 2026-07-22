import {
  ClientAgentAccessRequest,
  type ClientAgentAccessRequestStatus,
} from "../../domain/entities/client_agent_access_request.entity";
import type { User } from "../../domain/entities/user.entity";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import type { IPendingClientAgentAccessWriter } from "../../domain/ports/pending_client_agent_access_writer.port";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import type {
  ClientAgentAccessApprovalToken,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import { env } from "../../shared/config/env";
import { conflict, forbidden, notFound } from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { parseExpiryToDate } from "../../shared/utils/date";
import { generateOpaqueClientAccessToken } from "../../shared/utils/client_access_token";
import { logger } from "../../shared/utils/logger";
import { clientAgentAccessRevokedByClientDecisionReason } from "./client_agent_access_decision_reasons";
import { enqueueClientAccessApprovalEmails } from "./registration_email_outbox.service";
import { recordClientAgentAccessRequestPost } from "../../shared/metrics/client_agent_access_request.metrics";
import { revokeConsumerClientAccessSockets } from "./consumer_socket_control_sink";
import { isClientAccessRequestRetryEligible } from "../../domain/policies/client_agent_access_request.policy";
import type { ClientAgentLiveProfileDeps } from "./agent_snapshot_refresher";
import { sendClientAccessRequestEmails } from "./client_agent_access_notifications";
import {
  filterRequestRecords,
  paginateRequestRecords,
  toRequestRecord,
} from "./client_agent_access_request_records";
import type {
  ClientAgentAccessRequestListFilter,
  ClientAgentAccessRequestPage,
  ClientAgentAccessRequestRecord,
  ClientAgentAccessRequestResult,
} from "./client_agent_access_types";

// Re-export to avoid an unused import for `ClientAgentAccessRequestStatus`
export type { ClientAgentAccessRequestStatus };

/**
 * Owns the client-facing request lifecycle: paginated listing, requesting
 * access, retrying, and self-removing an approved grant.
 */
export class ClientAgentAccessRequestService {
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
    private readonly liveProfileDeps?: ClientAgentLiveProfileDeps,
  ) {}

  async listRequestsPage(
    clientId: string,
    filter?: ClientAgentAccessRequestListFilter,
  ): Promise<ClientAgentAccessRequestPage> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);
    if (env.nodeEnv === "test" && filter?.search !== undefined && filter.search.trim() !== "") {
      const items = filterRequestRecords(await this.listRequests(clientId), filter);
      return paginateRequestRecords(items, page, pageSize);
    }

    const result = await this.clientAgentAccessRequestRepository.listByClientPage(clientId, {
      ...(filter?.status !== undefined ? { status: filter.status } : {}),
      ...(filter?.search !== undefined ? { search: filter.search } : {}),
      page,
      pageSize,
    });

    return {
      items: result.items.map((request) => toRequestRecord(request)),
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

      // Only count true retries (rejected/expired/revoked, or approved without access).
      // Pending email resends after debounce must not burn CLIENT_AGENT_ACCESS_MAX_RETRIES.
      const shouldIncrementRetry =
        existing !== undefined &&
        existing.status !== "pending" &&
        (isClientAccessRequestRetryEligible(existing.status) || existing.status === "approved");

      const maxRetries = env.clientAgentAccessMaxRetries;
      if (existing && shouldIncrementRetry && maxRetries > 0 && existing.retryCount >= maxRetries) {
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
          retryCount: shouldIncrementRetry ? existing.retryCount + 1 : existing.retryCount,
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
      await sendClientAccessRequestEmails(this.emailSender, emailInputs);
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

  async removeApprovedAccess(clientId: string, agentIds: string[]): Promise<Result<void>> {
    const uniqueAgentIds = [...new Set(agentIds)];
    const [approvedAgentIds, requestsByAgent] = await Promise.all([
      this.clientAgentAccessRepository.listAccessAgentIdsForClientIn(clientId, uniqueAgentIds),
      this.clientAgentAccessRequestRepository.findByClientAndAgents(clientId, uniqueAgentIds),
    ]);
    await this.clientAgentAccessRepository.removeAgentIds(clientId, uniqueAgentIds);
    for (const agentId of uniqueAgentIds) {
      this.liveProfileDeps?.onAccessRevoked?.(clientId, agentId);
      const request = requestsByAgent.get(agentId);
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

  /**
   * Reads-paginated requests (used internally when `nodeEnv === "test"` and a
   * `search` filter is set, to mirror legacy behavior).
   */
  private async listRequests(clientId: string): Promise<ClientAgentAccessRequestRecord[]> {
    const requests = await this.clientAgentAccessRequestRepository.listByClientId(clientId);
    const agentIds = [...new Set(requests.map((r) => r.agentId))];
    const agents = await this.agentRepository.findByIds(agentIds);
    const agentsById = new Map(agents.map((agent) => [agent.agentId, agent] as const));
    return requests.map((request) =>
      toRequestRecord(
        Object.assign(
          request,
          agentsById.get(request.agentId)?.name !== undefined
            ? { agentName: agentsById.get(request.agentId)!.name }
            : {},
        ),
      ),
    );
  }

  private newApprovalToken(requestId: string): ClientAgentAccessApprovalToken {
    return {
      id: generateOpaqueClientAccessToken(),
      requestId,
      expiresAt: parseExpiryToDate(env.approvalTokenExpiresIn),
      createdAt: new Date(),
    };
  }
}
