import type { ClientAgentAccessRequest } from "../entities/client_agent_access_request.entity";
import type { ClientAgentAccessApprovalToken } from "../repositories/client_agent_access_approval_token.repository.interface";

export type PendingClientAgentAccessWriteItem = {
  readonly request: ClientAgentAccessRequest;
  readonly token: ClientAgentAccessApprovalToken;
};

export interface IPendingClientAgentAccessWriter {
  writePendingRequests(items: ReadonlyArray<PendingClientAgentAccessWriteItem>): Promise<void>;
}
