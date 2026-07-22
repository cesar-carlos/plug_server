import { ClientAgentAccessRequest } from "../../domain/entities/client_agent_access_request.entity";
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
      const existing = await this.clientAgentAccessRequestRepository.findByClientAndAgent(
        request.clientId,
        request.agentId,
      );
      // Keep the first id for the (clientId, agentId) pair under concurrent creates.
      const persisted =
        existing !== null && existing.id !== request.id
          ? new ClientAgentAccessRequest({
              ...request,
              id: existing.id,
              createdAt: existing.createdAt,
            })
          : request;
      await this.clientAgentAccessRequestRepository.save(persisted);
      await this.approvalTokenRepository.save({
        ...token,
        requestId: persisted.id,
      });
    }
  }
}
