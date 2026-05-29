import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import type { IClientAgentAccessApprovalTokenRepository } from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import type { IClientAgentAccessApprovalTxn } from "../../domain/ports/client_agent_access_approval_txn.port";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import {
  agentAccessDenied,
  conflict,
  notFound,
  registrationTokenExpired,
  serviceUnavailable,
} from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { isExpired } from "../../shared/utils/date";
import { logger } from "../../shared/utils/logger";
import { Prisma } from "@prisma/client";
import {
  clientAgentAccessExpiredDecisionReason,
  clientAgentAccessRevokedByOwnerDecisionReason,
} from "./client_agent_access_decision_reasons";
import {
  recordClientAgentAccessPublicDecisionFinished,
  recordClientAgentAccessPublicDecisionStarted,
  type ClientAgentAccessPublicDecision,
  type ClientAgentAccessPublicDecisionOutcome,
} from "../../shared/metrics/client_agent_access_public_decision.metrics";
import {
  grantConsumerClientAccessRooms,
  revokeConsumerClientAccessSockets,
} from "./consumer_socket_control_sink";
import {
  assertAgentEligibleForClientAccessGrant,
  assertClientEligibleForClientAccessGrant,
} from "../../domain/policies/client_agent_access_request.policy";
import { toSafeLogContext } from "../../shared/utils/safe_log_context";
import type { ClientAgentLiveProfileDeps } from "./agent_snapshot_refresher";
import {
  notifyClientAccessApproved,
  notifyClientAccessRejected,
} from "./client_agent_access_notifications";
import { loadClientsById, toRequestRecord } from "./client_agent_access_request_records";
import type {
  ClientAccessTokenDecisionOptions,
  ClientAgentAccessRequestPage,
  ClientAgentAccessReviewSummary,
  OwnerClientAccessRequestListFilter,
  OwnerManagedAgentClientPage,
  OwnerManagedAgentClientRecord,
} from "./client_agent_access_types";

/**
 * Decision flows for the (client, agent) access lifecycle. Handles both the
 * public token-based flow (`approveByToken` / `rejectByToken`, used by the
 * email-driven approval pages) and the owner-driven flow (`approveByOwner`,
 * `rejectByOwner`, `revokeAccessByOwner`).
 */
export class ClientAgentAccessDecisionService {
  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
    private readonly clientRepository: IClientRepository,
    private readonly clientAgentAccessRepository: IClientAgentAccessRepository,
    private readonly clientAgentAccessRequestRepository: IClientAgentAccessRequestRepository,
    private readonly approvalTokenRepository: IClientAgentAccessApprovalTokenRepository,
    private readonly emailSender: IEmailSender,
    private readonly approvalTxn: IClientAgentAccessApprovalTxn,
    private readonly liveProfileDeps?: ClientAgentLiveProfileDeps,
  ) {}

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

      await notifyClientAccessApproved(this.emailSender, client.email, request.agentId);
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
      await notifyClientAccessRejected(this.emailSender, client.email, request.agentId, reason);
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
      items: result.items.map((item) => toRequestRecord(item)),
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

    await notifyClientAccessApproved(this.emailSender, client.email, request.agentId);
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
    await notifyClientAccessRejected(this.emailSender, client.email, request.agentId, reason);
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
    const clientsById = await loadClientsById(
      this.clientRepository,
      accesses.map((access) => access.clientId),
    );
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
}
