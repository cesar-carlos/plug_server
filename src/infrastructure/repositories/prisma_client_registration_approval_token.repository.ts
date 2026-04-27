import type { ClientRegistrationApprovalToken as PrismaToken } from "@prisma/client";

import type {
  ClientRegistrationApprovalToken,
  ClientRegistrationApprovalReviewSummaryRecord,
  IClientRegistrationApprovalTokenRepository,
} from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { Client, ClientStatus } from "../../domain/entities/client.entity";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientRegistrationApprovalTokenRepository implements IClientRegistrationApprovalTokenRepository {
  async save(token: ClientRegistrationApprovalToken): Promise<void> {
    const hashedId = hashRegistrationToken(token.id);
    await prismaClient.clientRegistrationApprovalToken.upsert({
      where: { clientId: token.clientId },
      create: {
        id: hashedId,
        clientId: token.clientId,
        expiresAt: token.expiresAt,
        createdAt: token.createdAt,
      },
      update: {
        id: hashedId,
        expiresAt: token.expiresAt,
      },
    });
  }

  async replaceForClientRetry(
    _client: Client,
    token: ClientRegistrationApprovalToken,
  ): Promise<void> {
    await this.save(token);
  }

  async findById(id: string): Promise<ClientRegistrationApprovalToken | null> {
    const hashedId = hashRegistrationToken(id);
    const row = await prismaClient.clientRegistrationApprovalToken.findFirst({
      where: { OR: [{ id: hashedId }, { id }] },
    });

    return row ? this.toDomain(row) : null;
  }

  async findReviewSummaryById(
    id: string,
  ): Promise<ClientRegistrationApprovalReviewSummaryRecord | null> {
    const hashedId = hashRegistrationToken(id);
    const row = await prismaClient.clientRegistrationApprovalToken.findFirst({
      where: { OR: [{ id: hashedId }, { id }] },
      select: {
        expiresAt: true,
        client: {
          select: {
            email: true,
            name: true,
            lastName: true,
            status: true,
            user: {
              select: {
                email: true,
              },
            },
          },
        },
      },
    });

    if (!row) {
      return null;
    }

    return {
      ownerEmail: row.client.user.email,
      clientEmail: row.client.email,
      clientName: `${row.client.name} ${row.client.lastName}`.trim(),
      clientStatus: row.client.status as ClientStatus,
      expiresAt: row.expiresAt,
    };
  }

  async deleteById(id: string): Promise<void> {
    const hashedId = hashRegistrationToken(id);
    await prismaClient.clientRegistrationApprovalToken.deleteMany({
      where: {
        OR: [{ id: hashedId }, { id }],
      },
    });
  }

  private toDomain(row: PrismaToken): ClientRegistrationApprovalToken {
    return {
      id: row.id,
      clientId: row.clientId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
}
