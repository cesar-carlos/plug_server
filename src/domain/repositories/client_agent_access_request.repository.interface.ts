import type {
  ClientAgentAccessRequest,
  ClientAgentAccessRequestStatus,
} from "../entities/client_agent_access_request.entity";

export interface IClientAgentAccessRequestRepository {
  findById(id: string): Promise<ClientAgentAccessRequest | null>;
  findByClientAndAgent(clientId: string, agentId: string): Promise<ClientAgentAccessRequest | null>;
  listByClientId(clientId: string): Promise<ClientAgentAccessRequest[]>;
  listByOwnerUserId(ownerUserId: string): Promise<ClientAgentAccessRequest[]>;
  save(request: ClientAgentAccessRequest): Promise<void>;
  setStatus(
    requestId: string,
    status: Exclude<ClientAgentAccessRequestStatus, "pending">,
    options?: { decidedAt?: Date; reason?: string },
  ): Promise<void>;
}
