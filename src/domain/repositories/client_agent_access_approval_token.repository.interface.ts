import type { ClientAgentAccessRequestStatus } from "../entities/client_agent_access_request.entity";

export interface ClientAgentAccessApprovalToken {
  readonly id: string;
  readonly requestId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface ClientAgentAccessApprovalReviewSummaryRecord {
  readonly clientEmail: string;
  readonly clientName: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly requestStatus: ClientAgentAccessRequestStatus;
  readonly expiresAt: Date;
}

export interface IClientAgentAccessApprovalTokenRepository {
  save(token: ClientAgentAccessApprovalToken): Promise<void>;
  findById(id: string): Promise<ClientAgentAccessApprovalToken | null>;
  findReviewSummaryById(id: string): Promise<ClientAgentAccessApprovalReviewSummaryRecord | null>;
  deleteById(id: string): Promise<void>;
  deleteByRequestId(requestId: string): Promise<void>;
}
