import type { ClientRegistrationApprovalToken as PrismaToken } from "@prisma/client";

import type {
  ClientRegistrationApprovalToken,
  IClientRegistrationApprovalTokenRepository,
} from "../../domain/repositories/client_registration_approval_token.repository.interface";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";

export class PrismaClientRegistrationApprovalTokenRepository
  implements IClientRegistrationApprovalTokenRepository
{
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

  async findById(id: string): Promise<ClientRegistrationApprovalToken | null> {
    const hashedId = hashRegistrationToken(id);
    const row =
      (await prismaClient.clientRegistrationApprovalToken.findUnique({
        where: { id: hashedId },
      })) ??
      // Legacy compatibility for tokens stored before hashing rollout.
      (await prismaClient.clientRegistrationApprovalToken.findUnique({
        where: { id },
      }));

    return row ? this.toDomain(row) : null;
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
