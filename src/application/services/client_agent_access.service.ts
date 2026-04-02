import { ClientAgentAccessRequest } from "../../domain/entities/client_agent_access_request.entity";
import type { Agent } from "../../domain/entities/agent.entity";
import type { Client } from "../../domain/entities/client.entity";
import type { IEmailSender } from "../../domain/ports/email_sender.port";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";
import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";
import type {
  ClientAgentAccessApprovalToken,
  IClientAgentAccessApprovalTokenRepository,
} from "../../domain/repositories/client_agent_access_approval_token.repository.interface";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";
import { env } from "../../shared/config/env";
import {
  agentAccessDenied,
  conflict,
  notFound,
  registrationTokenExpired,
} from "../../shared/errors/http_errors";
import { type Result, err, ok } from "../../shared/errors/result";
import { isExpired, parseExpiryToDate } from "../../shared/utils/date";
import { generateOpaqueClientAccessToken } from "../../shared/utils/client_access_token";

export interface ClientAgentAccessRequestRecord {
  readonly id: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly status: "pending" | "approved" | "rejected" | "expired";
  readonly requestedAt: Date;
  readonly decidedAt?: Date;
  readonly decisionReason?: string;
}

export interface ClientAgentAccessRequestListFilter {
  readonly status?: "pending" | "approved" | "rejected" | "expired";
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
  readonly requested: string[];
  readonly alreadyApproved: string[];
}

export class ClientAgentAccessService {
  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
    private readonly clientRepository: IClientRepository,
    private readonly userRepository: IUserRepository,
    private readonly clientAgentAccessRepository: IClientAgentAccessRepository,
    private readonly clientAgentAccessRequestRepository: IClientAgentAccessRequestRepository,
    private readonly approvalTokenRepository: IClientAgentAccessApprovalTokenRepository,
    private readonly emailSender: IEmailSender,
  ) {}

  async listApprovedAgentIds(clientId: string): Promise<string[]> {
    return this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
  }

  async listApprovedAgents(clientId: string): Promise<Agent[]> {
    const agentIds = await this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
    const agents = await this.agentRepository.findByIds(agentIds);
    const agentsById = new Map(agents.map((agent) => [agent.agentId, agent] as const));
    return agentIds
      .map((agentId) => agentsById.get(agentId))
      .filter((agent): agent is Agent => agent !== undefined);
  }

  async listApprovedAgentsPage(clientId: string, filter?: AgentListFilter): Promise<PaginatedAgentList> {
    const agentIds = await this.clientAgentAccessRepository.listAgentIdsByClientId(clientId);
    return this.agentRepository.findAll({
      ...(filter ?? {}),
      agentIds,
    });
  }

  async findApprovedAgent(clientId: string, agentId: string): Promise<Result<Agent>> {
    const hasAccess = await this.clientAgentAccessRepository.hasAccess(clientId, agentId);
    if (!hasAccess) {
      return err(agentAccessDenied(agentId));
    }

    const agent = await this.agentRepository.findById(agentId);
    if (!agent) {
      return err(notFound(`Agent ${agentId}`));
    }

    return ok(agent);
  }

  async listRequests(clientId: string): Promise<ClientAgentAccessRequestRecord[]> {
    const requests = await this.clientAgentAccessRequestRepository.listByClientId(clientId);
    const agentsById = await this.loadAgentsById(requests.map((request) => request.agentId));
    return requests.map((request) => ({
      id: request.id,
      clientId: request.clientId,
      agentId: request.agentId,
      ...(agentsById.get(request.agentId) !== undefined
        ? { agentName: agentsById.get(request.agentId)!.name }
        : {}),
      status: request.status,
      requestedAt: request.requestedAt,
      ...(request.decidedAt !== undefined ? { decidedAt: request.decidedAt } : {}),
      ...(request.decisionReason !== undefined ? { decisionReason: request.decisionReason } : {}),
    }));
  }

  async listRequestsPage(
    clientId: string,
    filter?: ClientAgentAccessRequestListFilter,
  ): Promise<ClientAgentAccessRequestPage> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);
    let items = await this.listRequests(clientId);

    if (filter?.status !== undefined) {
      items = items.filter((request) => request.status === filter.status);
    }

    if (filter?.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      items = items.filter(
        (request) =>
          request.agentId.toLowerCase().includes(query) ||
          (request.agentName?.toLowerCase().includes(query) ?? false),
      );
    }

    const total = items.length;
    const start = (page - 1) * pageSize;

    return {
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }

  async requestAccess(clientId: string, agentIds: string[]): Promise<Result<ClientAgentAccessRequestResult>> {
    const client = await this.clientRepository.findById(clientId);
    if (!client) {
      return err(notFound("Client"));
    }

    const uniqueAgentIds = [...new Set(agentIds)];
    const requested: string[] = [];
    const alreadyApproved: string[] = [];

    for (const agentId of uniqueAgentIds) {
      const agent = await this.agentRepository.findById(agentId);
      if (!agent) {
        return err(notFound(`Agent ${agentId}`));
      }

      const accessAlreadyGranted = await this.clientAgentAccessRepository.hasAccess(clientId, agentId);
      if (accessAlreadyGranted) {
        alreadyApproved.push(agentId);
        continue;
      }

      const ownerUserId = await this.agentIdentityRepository.findOwnerUserId(agentId);
      if (!ownerUserId) {
        return err(conflict(`Agent ${agentId} has no responsible user`));
      }
      const owner = await this.userRepository.findById(ownerUserId);
      if (!owner) {
        return err(notFound("Owner user"));
      }

      const existing = await this.clientAgentAccessRequestRepository.findByClientAndAgent(clientId, agentId);
      let request: ClientAgentAccessRequest;
      if (existing) {
        if (existing.status === "approved") {
          alreadyApproved.push(agentId);
          continue;
        }
        request = new ClientAgentAccessRequest({
          ...existing,
          status: "pending",
          requestedAt: new Date(),
          updatedAt: new Date(),
        });
      } else {
        request = ClientAgentAccessRequest.create({
          clientId,
          agentId,
        });
      }
      await this.clientAgentAccessRequestRepository.save(request);

      const approvalToken = this.newApprovalToken(request.id);
      await this.approvalTokenRepository.save(approvalToken);
      await this.emailSender.sendClientAccessRequestToOwner({
        ownerEmail: owner.email,
        clientEmail: client.email,
        clientName: client.name,
        clientLastName: client.lastName,
        agentId,
        approvalToken: approvalToken.id,
      });

      requested.push(agentId);
    }

    return ok({ requested, alreadyApproved });
  }

  async removeApprovedAccess(clientId: string, agentIds: string[]): Promise<Result<void>> {
    const uniqueAgentIds = [...new Set(agentIds)];
    await this.clientAgentAccessRepository.removeAgentIds(clientId, uniqueAgentIds);
    return ok(undefined);
  }

  async approveByToken(tokenId: string): Promise<Result<{ clientEmail: string; agentId: string }>> {
    const token = await this.approvalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Approval link is invalid or has expired"));
    }
    const request = await this.clientAgentAccessRequestRepository.findById(token.requestId);
    if (!request) {
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(notFound("Access request not found"));
    }
    if (isExpired(token.expiresAt)) {
      await this.clientAgentAccessRequestRepository.setStatus(request.id, "expired");
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(registrationTokenExpired("This approval link has expired"));
    }
    if (request.status !== "pending") {
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(conflict("Access request already processed"));
    }

    await this.clientAgentAccessRepository.addAccess(request.clientId, request.agentId, new Date());
    await this.clientAgentAccessRequestRepository.setStatus(request.id, "approved");
    await this.approvalTokenRepository.deleteById(tokenId);

    const client = await this.clientRepository.findById(request.clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    await this.emailSender.sendClientAccessApproved({
      clientEmail: client.email,
      agentId: request.agentId,
    });
    return ok({ clientEmail: client.email, agentId: request.agentId });
  }

  async rejectByToken(tokenId: string, reason?: string): Promise<Result<{ clientEmail: string; agentId: string }>> {
    const token = await this.approvalTokenRepository.findById(tokenId);
    if (!token) {
      return err(notFound("Rejection link is invalid or has expired"));
    }
    const request = await this.clientAgentAccessRequestRepository.findById(token.requestId);
    if (!request) {
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(notFound("Access request not found"));
    }
    if (isExpired(token.expiresAt)) {
      await this.clientAgentAccessRequestRepository.setStatus(request.id, "expired");
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(registrationTokenExpired("This rejection link has expired"));
    }
    if (request.status !== "pending") {
      await this.approvalTokenRepository.deleteById(tokenId);
      return err(conflict("Access request already processed"));
    }

    await this.clientAgentAccessRequestRepository.setStatus(request.id, "rejected", {
      ...(reason !== undefined ? { reason } : {}),
    });
    await this.approvalTokenRepository.deleteById(tokenId);

    const client = await this.clientRepository.findById(request.clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    await this.emailSender.sendClientAccessRejected({
      clientEmail: client.email,
      agentId: request.agentId,
      ...(reason ? { reason } : {}),
    });
    return ok({ clientEmail: client.email, agentId: request.agentId });
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
    interface OwnerRequestSearchRecord extends ClientAgentAccessRequestRecord {
      readonly clientEmail?: string;
      readonly clientName?: string;
    }

    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);
    let requests = await this.clientAgentAccessRequestRepository.listByOwnerUserId(ownerUserId);
    requests = await this.filterRequestsByOwner(ownerUserId, requests);
    const agentsById = await this.loadAgentsById(requests.map((request) => request.agentId));
    const clientsById = await this.loadClientsById(requests.map((request) => request.clientId));
    let items: OwnerRequestSearchRecord[] = requests.map((request) => ({
      id: request.id,
      clientId: request.clientId,
      agentId: request.agentId,
      ...(agentsById.get(request.agentId) !== undefined
        ? { agentName: agentsById.get(request.agentId)!.name }
        : {}),
      status: request.status,
      requestedAt: request.requestedAt,
      ...(request.decidedAt !== undefined ? { decidedAt: request.decidedAt } : {}),
      ...(request.decisionReason !== undefined ? { decisionReason: request.decisionReason } : {}),
      ...(clientsById.get(request.clientId) !== undefined
        ? { clientEmail: clientsById.get(request.clientId)!.email }
        : {}),
      ...(clientsById.get(request.clientId) !== undefined
        ? { clientName: `${clientsById.get(request.clientId)!.name} ${clientsById.get(request.clientId)!.lastName}` }
        : {}),
    }));

    if (filter?.status !== undefined) {
      items = items.filter((request) => request.status === filter.status);
    }
    if (filter?.agentId !== undefined) {
      items = items.filter((request) => request.agentId === filter.agentId);
    }
    if (filter?.clientId !== undefined) {
      items = items.filter((request) => request.clientId === filter.clientId);
    }
    if (filter?.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      items = items.filter(
        (request) =>
          request.agentId.toLowerCase().includes(query) ||
          (request.agentName?.toLowerCase().includes(query) ?? false) ||
          request.clientId.toLowerCase().includes(query) ||
          (request.clientEmail?.toLowerCase().includes(query) ?? false) ||
          (request.clientName?.toLowerCase().includes(query) ?? false),
      );
    }

    const total = items.length;
    const start = (page - 1) * pageSize;
    return ok({
      items: items.slice(start, start + pageSize).map((item) => ({
        id: item.id,
        clientId: item.clientId,
        agentId: item.agentId,
        ...(item.agentName !== undefined ? { agentName: item.agentName } : {}),
        status: item.status,
        requestedAt: item.requestedAt,
        ...(item.decidedAt !== undefined ? { decidedAt: item.decidedAt } : {}),
        ...(item.decisionReason !== undefined ? { decisionReason: item.decisionReason } : {}),
      })),
      total,
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

    await this.clientAgentAccessRepository.addAccess(request.clientId, request.agentId, new Date());
    await this.clientAgentAccessRequestRepository.setStatus(request.id, "approved");

    const client = await this.clientRepository.findById(request.clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    await this.emailSender.sendClientAccessApproved({
      clientEmail: client.email,
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

    await this.clientAgentAccessRequestRepository.setStatus(request.id, "rejected", {
      ...(reason !== undefined ? { reason } : {}),
    });

    const client = await this.clientRepository.findById(request.clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    await this.emailSender.sendClientAccessRejected({
      clientEmail: client.email,
      agentId: request.agentId,
      ...(reason ? { reason } : {}),
    });
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

    const total = items.length;
    const start = (page - 1) * pageSize;
    return ok({
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    });
  }

  async revokeAccessByOwner(ownerUserId: string, agentId: string, clientId: string): Promise<Result<void>> {
    const ownerResult = await this.assertAgentOwnership(ownerUserId, agentId);
    if (!ownerResult.ok) {
      return ownerResult;
    }
    const client = await this.clientRepository.findById(clientId);
    if (!client) {
      return err(notFound("Client"));
    }
    await this.clientAgentAccessRepository.removeAccess(clientId, agentId);
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

  private async loadAgentsById(agentIds: readonly string[]): Promise<Map<string, Agent>> {
    const uniqueAgentIds = [...new Set(agentIds)];
    const agents = await this.agentRepository.findByIds(uniqueAgentIds);
    return new Map(agents.map((agent) => [agent.agentId, agent] as const));
  }

  private async loadClientsById(clientIds: readonly string[]): Promise<Map<string, Client>> {
    const uniqueClientIds = [...new Set(clientIds)];
    const clients = await Promise.all(uniqueClientIds.map((clientId) => this.clientRepository.findById(clientId)));
    const map = new Map<string, Client>();
    for (const client of clients) {
      if (client) {
        map.set(client.id, client);
      }
    }
    return map;
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

  private async filterRequestsByOwner(
    ownerUserId: string,
    requests: readonly ClientAgentAccessRequest[],
  ): Promise<ClientAgentAccessRequest[]> {
    const ownerChecks = await Promise.all(
      requests.map(async (request) => {
        const owner = await this.agentIdentityRepository.findOwnerUserId(request.agentId);
        return owner === ownerUserId;
      }),
    );
    return requests.filter((_, index) => ownerChecks[index] === true);
  }
}
