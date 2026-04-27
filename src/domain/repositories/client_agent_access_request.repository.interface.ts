import type {
  ClientAgentAccessRequest,
  ClientAgentAccessRequestStatus,
} from "../entities/client_agent_access_request.entity";

export interface IClientAgentAccessRequestRepository {
  findById(id: string): Promise<ClientAgentAccessRequest | null>;
  findByClientAndAgent(clientId: string, agentId: string): Promise<ClientAgentAccessRequest | null>;
  findByClientAndAgents(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, ClientAgentAccessRequest>>;
  listByClientId(clientId: string): Promise<ClientAgentAccessRequest[]>;
  listByOwnerUserId(ownerUserId: string): Promise<ClientAgentAccessRequest[]>;
  listByClientPage(
    clientId: string,
    filter: {
      readonly status?: ClientAgentAccessRequestStatus;
      readonly search?: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<{
    readonly items: Array<
      ClientAgentAccessRequest & {
        readonly agentName?: string;
      }
    >;
    readonly total: number;
  }>;
  listByOwnerPage(
    ownerUserId: string,
    filter: {
      readonly status?: ClientAgentAccessRequestStatus;
      readonly search?: string;
      readonly agentId?: string;
      readonly clientId?: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<{
    readonly items: Array<
      ClientAgentAccessRequest & {
        readonly agentName?: string;
        readonly clientEmail?: string;
        readonly clientName?: string;
      }
    >;
    readonly total: number;
  }>;
  save(request: ClientAgentAccessRequest): Promise<void>;
  setStatus(
    requestId: string,
    status: Exclude<ClientAgentAccessRequestStatus, "pending">,
    options?: { decidedAt?: Date; reason?: string },
  ): Promise<void>;
}
