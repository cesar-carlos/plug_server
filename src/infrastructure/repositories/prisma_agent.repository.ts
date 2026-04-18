import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { Agent, type AgentStatus } from "../../domain/entities/agent.entity";
import type {
  AgentAccessSnapshot,
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
} from "../../domain/repositories/agent.repository.interface";
import type {
  AgentProfileCommitInput,
  AgentProfileCommitResult,
} from "../../domain/repositories/agent_profile_commit";
import { AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE } from "../../shared/messages/agent_profile";
import { prismaClient } from "../database/prisma/client";

function isPrismaUniqueConstraintOnAgentDocument(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  const joined = fields.join(" ");
  return fields.includes("document") || joined.includes("document");
}

export class PrismaAgentRepository implements IAgentRepository {
  async findById(agentId: string): Promise<Agent | null> {
    const record = await prismaClient.agent.findUnique({ where: { agentId } });
    return record ? this.toEntity(record) : null;
  }

  /**
   * Hot-path projection: only `agentId` + `status`. Avoids fetching the wide
   * profile/address columns on every access check.
   */
  async findAccessSnapshotById(agentId: string): Promise<AgentAccessSnapshot | null> {
    const row = await prismaClient.agent.findUnique({
      where: { agentId },
      select: { agentId: true, status: true },
    });
    if (!row) return null;
    return { agentId: row.agentId, status: row.status as AgentStatus };
  }

  async findByDocument(document: string): Promise<Agent | null> {
    const record = await prismaClient.agent.findUnique({ where: { document } });
    return record ? this.toEntity(record) : null;
  }

  async findByIds(agentIds: string[]): Promise<Agent[]> {
    if (agentIds.length === 0) {
      return [];
    }

    const records = await prismaClient.agent.findMany({
      where: { agentId: { in: [...new Set(agentIds)] } },
    });

    return records.map((record) => this.toEntity(record));
  }

  async findAll(filter?: AgentListFilter): Promise<PaginatedAgentList> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);

    if (filter?.agentIds !== undefined && filter.agentIds.length === 0) {
      return {
        items: [],
        total: 0,
        page,
        pageSize,
      };
    }

    const where = {
      ...(filter?.agentIds !== undefined && filter.agentIds.length > 0
        ? { agentId: { in: [...new Set(filter.agentIds)] } }
        : {}),
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.search
        ? {
            OR: [
              { name: { contains: filter.search, mode: "insensitive" as const } },
              { tradeName: { contains: filter.search, mode: "insensitive" as const } },
              { document: { contains: filter.search } },
            ],
          }
        : {}),
    };

    const [records, total] = await Promise.all([
      prismaClient.agent.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prismaClient.agent.count({ where }),
    ]);

    return {
      items: records.map((record) => this.toEntity(record)),
      total,
      page,
      pageSize,
    };
  }

  async save(agent: Agent): Promise<void> {
    await prismaClient.agent.create({
      data: {
        agentId: agent.agentId,
        name: agent.name,
        tradeName: agent.tradeName ?? null,
        document: agent.document ?? null,
        documentType: agent.documentType ?? null,
        phone: agent.phone ?? null,
        mobile: agent.mobile ?? null,
        email: agent.email ?? null,
        street: agent.street ?? null,
        number: agent.number ?? null,
        district: agent.district ?? null,
        postalCode: agent.postalCode ?? null,
        city: agent.city ?? null,
        state: agent.state ?? null,
        notes: agent.notes ?? null,
        profileUpdatedAt: agent.profileUpdatedAt ?? null,
        profileVersion: agent.profileVersion,
        lastLoginUserId: agent.lastLoginUserId ?? null,
        status: agent.status,
      },
    });
  }

  async update(agent: Agent): Promise<void> {
    await prismaClient.agent.update({
      where: { agentId: agent.agentId },
      data: {
        name: agent.name,
        tradeName: agent.tradeName ?? null,
        document: agent.document ?? null,
        documentType: agent.documentType ?? null,
        phone: agent.phone ?? null,
        mobile: agent.mobile ?? null,
        email: agent.email ?? null,
        street: agent.street ?? null,
        number: agent.number ?? null,
        district: agent.district ?? null,
        postalCode: agent.postalCode ?? null,
        city: agent.city ?? null,
        state: agent.state ?? null,
        notes: agent.notes ?? null,
        profileUpdatedAt: agent.profileUpdatedAt ?? null,
        profileVersion: agent.profileVersion,
        lastLoginUserId: agent.lastLoginUserId ?? null,
        status: agent.status,
      },
    });
  }

  async commitAgentProfileChange(
    input: AgentProfileCommitInput,
  ): Promise<AgentProfileCommitResult> {
    return prismaClient.$transaction(async (tx) => {
      const agentId = input.nextAgent.agentId;

      if (input.dedupeKey) {
        const idem = await tx.agentProfileWriteIdempotency.findUnique({
          where: {
            agentId_dedupeKey: {
              agentId,
              dedupeKey: input.dedupeKey,
            },
          },
        });
        if (idem) {
          if (idem.patchFingerprint !== input.patchFingerprint) {
            return {
              status: "conflict",
              message: "Idempotency key reused with a different profile payload",
            };
          }
          const row = await tx.agent.findUnique({ where: { agentId } });
          if (!row) {
            return { status: "conflict", message: "Agent not found after idempotent lookup" };
          }
          return { status: "idempotent", agent: this.toEntity(row) };
        }
      }

      if (input.mode === "create") {
        if (
          await PrismaAgentRepository.anotherAgentOwnsDocument(
            tx,
            agentId,
            input.nextAgent.document,
          )
        ) {
          return {
            status: "conflict",
            message: AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE,
            reason: "document_not_unique",
          };
        }
        try {
          await tx.agent.create({
            data: PrismaAgentRepository.agentToPrismaCreate(input.nextAgent),
          });
        } catch (error) {
          if (isPrismaUniqueConstraintOnAgentDocument(error)) {
            return {
              status: "conflict",
              message: AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE,
              reason: "document_not_unique",
            };
          }
          throw error;
        }
        await tx.agentProfileRevision.create({
          data: {
            id: randomUUID(),
            agentId,
            profileVersion: input.nextAgent.profileVersion,
            source: input.source,
            actorUserId: input.actorUserId ?? null,
            requestId: input.requestId ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            changedFields: [...input.changedFields],
            snapshotJson: input.snapshotJson as Prisma.InputJsonValue,
          },
        });
        if (input.dedupeKey) {
          await tx.agentProfileWriteIdempotency.create({
            data: {
              id: randomUUID(),
              agentId,
              dedupeKey: input.dedupeKey,
              patchFingerprint: input.patchFingerprint,
              resultingProfileVersion: input.nextAgent.profileVersion,
            },
          });
        }
        await tx.auditEvent.create({
          data: {
            id: randomUUID(),
            eventType: "agent.profile.updated",
            actorUserId: input.actorUserId ?? null,
            agentId,
            requestId: input.requestId ?? null,
            payloadJson: {
              source: input.source,
              profileVersion: input.nextAgent.profileVersion,
              changedFields: input.changedFields,
              mode: "created",
            },
          },
        });
        const row = await tx.agent.findUnique({ where: { agentId } });
        return { status: "committed", agent: this.toEntity(row!) };
      }

      if (
        await PrismaAgentRepository.anotherAgentOwnsDocument(tx, agentId, input.nextAgent.document)
      ) {
        return {
          status: "conflict",
          message: AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE,
          reason: "document_not_unique",
        };
      }

      let updated;
      try {
        updated = await tx.agent.updateMany({
          where: { agentId, profileVersion: input.previousProfileVersion },
          data: PrismaAgentRepository.agentToPrismaUpdate(input.nextAgent),
        });
      } catch (error) {
        if (isPrismaUniqueConstraintOnAgentDocument(error)) {
          return {
            status: "conflict",
            message: AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE,
            reason: "document_not_unique",
          };
        }
        throw error;
      }

      if (updated.count === 0) {
        return {
          status: "conflict",
          message: "Agent profile version changed concurrently or expected version mismatch",
        };
      }

      await tx.agentProfileRevision.create({
        data: {
          id: randomUUID(),
          agentId,
          profileVersion: input.nextAgent.profileVersion,
          source: input.source,
          actorUserId: input.actorUserId ?? null,
          requestId: input.requestId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          changedFields: [...input.changedFields],
          snapshotJson: input.snapshotJson as Prisma.InputJsonValue,
        },
      });

      if (input.dedupeKey) {
        await tx.agentProfileWriteIdempotency.create({
          data: {
            id: randomUUID(),
            agentId,
            dedupeKey: input.dedupeKey,
            patchFingerprint: input.patchFingerprint,
            resultingProfileVersion: input.nextAgent.profileVersion,
          },
        });
      }

      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          eventType: "agent.profile.updated",
          actorUserId: input.actorUserId ?? null,
          agentId,
          requestId: input.requestId ?? null,
          payloadJson: {
            source: input.source,
            profileVersion: input.nextAgent.profileVersion,
            changedFields: input.changedFields,
            mode: "updated",
          },
        },
      });

      const row = await tx.agent.findUnique({ where: { agentId } });
      return { status: "committed", agent: this.toEntity(row!) };
    });
  }

  private static async anotherAgentOwnsDocument(
    tx: Prisma.TransactionClient,
    agentId: string,
    document: string | undefined,
  ): Promise<boolean> {
    if (document === undefined || document === null || document === "") {
      return false;
    }
    const row = await tx.agent.findFirst({
      where: { document, NOT: { agentId } },
      select: { agentId: true },
    });
    return row !== null;
  }

  private static agentToPrismaCreate(agent: Agent): {
    agentId: string;
    name: string;
    tradeName: string | null;
    document: string | null;
    documentType: "cpf" | "cnpj" | null;
    phone: string | null;
    mobile: string | null;
    email: string | null;
    street: string | null;
    number: string | null;
    district: string | null;
    postalCode: string | null;
    city: string | null;
    state: string | null;
    notes: string | null;
    profileUpdatedAt: Date | null;
    profileVersion: number;
    lastLoginUserId: string | null;
    status: "active" | "inactive";
  } {
    return {
      agentId: agent.agentId,
      name: agent.name,
      tradeName: agent.tradeName ?? null,
      document: agent.document ?? null,
      documentType: agent.documentType ?? null,
      phone: agent.phone ?? null,
      mobile: agent.mobile ?? null,
      email: agent.email ?? null,
      street: agent.street ?? null,
      number: agent.number ?? null,
      district: agent.district ?? null,
      postalCode: agent.postalCode ?? null,
      city: agent.city ?? null,
      state: agent.state ?? null,
      notes: agent.notes ?? null,
      profileUpdatedAt: agent.profileUpdatedAt ?? null,
      profileVersion: agent.profileVersion,
      lastLoginUserId: agent.lastLoginUserId ?? null,
      status: agent.status,
    };
  }

  private static agentToPrismaUpdate(agent: Agent): {
    name: string;
    tradeName: string | null;
    document: string | null;
    documentType: "cpf" | "cnpj" | null;
    phone: string | null;
    mobile: string | null;
    email: string | null;
    street: string | null;
    number: string | null;
    district: string | null;
    postalCode: string | null;
    city: string | null;
    state: string | null;
    notes: string | null;
    profileUpdatedAt: Date | null;
    profileVersion: number;
    lastLoginUserId: string | null;
    status: "active" | "inactive";
  } {
    return {
      name: agent.name,
      tradeName: agent.tradeName ?? null,
      document: agent.document ?? null,
      documentType: agent.documentType ?? null,
      phone: agent.phone ?? null,
      mobile: agent.mobile ?? null,
      email: agent.email ?? null,
      street: agent.street ?? null,
      number: agent.number ?? null,
      district: agent.district ?? null,
      postalCode: agent.postalCode ?? null,
      city: agent.city ?? null,
      state: agent.state ?? null,
      notes: agent.notes ?? null,
      profileUpdatedAt: agent.profileUpdatedAt ?? null,
      profileVersion: agent.profileVersion,
      lastLoginUserId: agent.lastLoginUserId ?? null,
      status: agent.status,
    };
  }

  private toEntity(record: {
    agentId: string;
    name: string;
    tradeName: string | null;
    document: string | null;
    documentType: "cpf" | "cnpj" | null;
    phone: string | null;
    mobile: string | null;
    email: string | null;
    street: string | null;
    number: string | null;
    district: string | null;
    postalCode: string | null;
    city: string | null;
    state: string | null;
    notes: string | null;
    profileUpdatedAt: Date | null;
    profileVersion: number;
    lastLoginUserId: string | null;
    status: "active" | "inactive";
    createdAt: Date;
    updatedAt: Date;
  }): Agent {
    return Agent.create({
      agentId: record.agentId,
      name: record.name,
      ...(record.tradeName !== null ? { tradeName: record.tradeName } : {}),
      ...(record.document !== null ? { document: record.document } : {}),
      ...(record.documentType !== null ? { documentType: record.documentType } : {}),
      ...(record.phone !== null ? { phone: record.phone } : {}),
      ...(record.mobile !== null ? { mobile: record.mobile } : {}),
      ...(record.email !== null ? { email: record.email } : {}),
      ...(record.notes !== null ? { notes: record.notes } : {}),
      ...(record.profileUpdatedAt !== null ? { profileUpdatedAt: record.profileUpdatedAt } : {}),
      profileVersion: record.profileVersion,
      ...(record.lastLoginUserId !== null ? { lastLoginUserId: record.lastLoginUserId } : {}),
      address: {
        ...(record.street !== null ? { street: record.street } : {}),
        ...(record.number !== null ? { number: record.number } : {}),
        ...(record.district !== null ? { district: record.district } : {}),
        ...(record.postalCode !== null ? { postalCode: record.postalCode } : {}),
        ...(record.city !== null ? { city: record.city } : {}),
        ...(record.state !== null ? { state: record.state } : {}),
      },
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}
