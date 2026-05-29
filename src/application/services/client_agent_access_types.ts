import type { ClientAgentAccessRequestStatus } from "../../domain/entities/client_agent_access_request.entity";
import type { Agent } from "../../domain/entities/agent.entity";

export type { ClientAgentLiveProfileDeps } from "./agent_snapshot_refresher";

/**
 * Audit event types for the per-(client, agent) bearer token storage.
 * Stored in `audit_events.event_type`. The token value itself is **never**
 * persisted — only metadata (length and whether a previous value existed).
 */
export const CLIENT_TOKEN_AUDIT_EVENT_TYPE_SET = "client_token.set";
export const CLIENT_TOKEN_AUDIT_EVENT_TYPE_CLEARED = "client_token.cleared";

export interface ClientTokenAuditPayload {
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

export interface ClientAccessTokenDecisionOptions {
  readonly requestId?: string;
}
