import type {
  ClientAgentAccessRequest as PrismaClientAgentAccessRequest,
  ClientAgentAccessRequestStatus as PrismaClientAgentAccessRequestStatus,
} from "@prisma/client";

import {
  ClientAgentAccessRequest,
  type ClientAgentAccessRequestStatus,
} from "../../domain/entities/client_agent_access_request.entity";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientAgentAccessRequestRepository implements IClientAgentAccessRequestRepository {
  async findById(id: string): Promise<ClientAgentAccessRequest | null> {
    const row = await prismaClient.clientAgentAccessRequest.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByClientAndAgent(
    clientId: string,
    agentId: string,
  ): Promise<ClientAgentAccessRequest | null> {
    const row = await prismaClient.clientAgentAccessRequest.findUnique({
      where: {
        clientId_agentId: {
          clientId,
          agentId,
        },
      },
    });
    return row ? this.toDomain(row) : null;
  }

  async findByClientAndAgents(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, ClientAgentAccessRequest>> {
    const unique = [...new Set(agentIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await prismaClient.clientAgentAccessRequest.findMany({
      where: { clientId, agentId: { in: unique } },
    });
    return new Map(rows.map((row) => [row.agentId, this.toDomain(row)] as const));
  }

  async listByClientId(clientId: string): Promise<ClientAgentAccessRequest[]> {
    const rows = await prismaClient.clientAgentAccessRequest.findMany({
      where: { clientId },
      orderBy: { requestedAt: "desc" },
    });
    return rows.map((item) => this.toDomain(item));
  }

  async listByOwnerUserId(ownerUserId: string): Promise<ClientAgentAccessRequest[]> {
    const rows = await prismaClient.clientAgentAccessRequest.findMany({
      where: {
        agent: {
          agentIdentities: {
            some: {
              userId: ownerUserId,
            },
          },
        },
      },
      orderBy: { requestedAt: "desc" },
    });
    return rows.map((item) => this.toDomain(item));
  }

  async listByClientPage(
    clientId: string,
    filter: {
      readonly status?: ClientAgentAccessRequestStatus;
      readonly search?: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<{
    readonly items: Array<ClientAgentAccessRequest & { readonly agentName?: string }>;
    readonly total: number;
  }> {
    const search = filter.search?.trim();
    const where = {
      clientId,
      ...(filter.status !== undefined
        ? { status: filter.status as PrismaClientAgentAccessRequestStatus }
        : {}),
      ...(search
        ? {
            OR: [
              { agentId: { contains: search } },
              { agent: { name: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prismaClient.clientAgentAccessRequest.findMany({
        where,
        include: { agent: { select: { name: true } } },
        orderBy: { requestedAt: "desc" },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      prismaClient.clientAgentAccessRequest.count({ where }),
    ]);

    return {
      items: rows.map((row) => Object.assign(this.toDomain(row), { agentName: row.agent.name })),
      total,
    };
  }

  async listByOwnerPage(
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
  }> {
    const search = filter.search?.trim();
    const where = {
      agent: {
        agentIdentities: {
          some: {
            userId: ownerUserId,
          },
        },
      },
      ...(filter.status !== undefined
        ? { status: filter.status as PrismaClientAgentAccessRequestStatus }
        : {}),
      ...(filter.agentId !== undefined ? { agentId: filter.agentId } : {}),
      ...(filter.clientId !== undefined ? { clientId: filter.clientId } : {}),
      ...(search
        ? {
            OR: [
              { agentId: { contains: search } },
              { agent: { name: { contains: search, mode: "insensitive" as const } } },
              { clientId: { contains: search } },
              { client: { email: { contains: search, mode: "insensitive" as const } } },
              { client: { name: { contains: search, mode: "insensitive" as const } } },
              { client: { lastName: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prismaClient.clientAgentAccessRequest.findMany({
        where,
        include: {
          agent: { select: { name: true } },
          client: { select: { email: true, name: true, lastName: true } },
        },
        orderBy: { requestedAt: "desc" },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      prismaClient.clientAgentAccessRequest.count({ where }),
    ]);

    return {
      items: rows.map((row) =>
        Object.assign(this.toDomain(row), {
          agentName: row.agent.name,
          clientEmail: row.client.email,
          clientName: `${row.client.name} ${row.client.lastName}`.trim(),
        }),
      ),
      total,
    };
  }

  async save(request: ClientAgentAccessRequest): Promise<void> {
    await prismaClient.clientAgentAccessRequest.upsert({
      where: { id: request.id },
      create: {
        id: request.id,
        clientId: request.clientId,
        agentId: request.agentId,
        status: request.status as PrismaClientAgentAccessRequestStatus,
        requestedAt: request.requestedAt,
        ...(request.decidedAt ? { decidedAt: request.decidedAt } : {}),
        ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      },
      update: {
        status: request.status as PrismaClientAgentAccessRequestStatus,
        requestedAt: request.requestedAt,
        decidedAt: request.decidedAt ?? null,
        decisionReason: request.decisionReason ?? null,
        updatedAt: request.updatedAt,
      },
    });
  }

  async setStatus(
    requestId: string,
    status: Exclude<ClientAgentAccessRequestStatus, "pending">,
    options?: { decidedAt?: Date; reason?: string },
  ): Promise<void> {
    await prismaClient.clientAgentAccessRequest.update({
      where: { id: requestId },
      data: {
        status: status as PrismaClientAgentAccessRequestStatus,
        decidedAt: options?.decidedAt ?? new Date(),
        decisionReason: options?.reason ?? null,
      },
    });
  }

  private toDomain(row: PrismaClientAgentAccessRequest): ClientAgentAccessRequest {
    return new ClientAgentAccessRequest({
      id: row.id,
      clientId: row.clientId,
      agentId: row.agentId,
      status: row.status as ClientAgentAccessRequestStatus,
      requestedAt: row.requestedAt,
      ...(row.decidedAt ? { decidedAt: row.decidedAt } : {}),
      ...(row.decisionReason ? { decisionReason: row.decisionReason } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
