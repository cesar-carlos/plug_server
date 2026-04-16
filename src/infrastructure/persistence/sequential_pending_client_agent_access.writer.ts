import type { ClientAgentAccessRequest } from "../../domain/entities/client_agent_access_request.entity";
import type { IPendingClientAgentAccessWriter } from "../../domain/ports/pending_client_agent_access_writer.port";
import type {
  ClientAgentAccessApprovalToken,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";

export class SequentialPendingClientAgentAccessWriter implements IPendingClientAgentAccessWriter {
  constructor(
    private readonly clientAgentAccessRequestRepository: IClientAgentAccessRequestRepository,
    private readonly approvalTokenRepository: IClientAgentAccessApprovalTokenRepository,
  ) {}

  async writePendingRequests(
    items: ReadonlyArray<{
      readonly request: ClientAgentAccessRequest;
      readonly token: ClientAgentAccessApprovalToken;
    }>,
  ): Promise<void> {
    for (const { request, token } of items) {
      await this.clientAgentAccessRequestRepository.save(request);
      await this.approvalTokenRepository.save(token);
    }
  }
}
