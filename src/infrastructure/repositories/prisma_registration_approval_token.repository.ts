import type { RegistrationApprovalToken as PrismaToken } from "@prisma/client";

import { RegistrationApprovalToken } from "../../domain/entities/registration_approval_token.entity";
import type { IRegistrationApprovalTokenRepository } from "../../domain/repositories/registration_approval_token.repository.interface";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";

export class PrismaRegistrationApprovalTokenRepository implements IRegistrationApprovalTokenRepository {
  async save(token: RegistrationApprovalToken): Promise<void> {
    const hashedId = hashRegistrationToken(token.id);
    await prismaClient.registrationApprovalToken.upsert({
      where: { id: hashedId },
      create: {
        id: hashedId,
        userId: token.userId,
        expiresAt: token.expiresAt,
        createdAt: token.createdAt,
      },
      update: {
        expiresAt: token.expiresAt,
      },
    });
  }

  async findById(id: string): Promise<RegistrationApprovalToken | null> {
    const hashedId = hashRegistrationToken(id);
    const row =
      (await prismaClient.registrationApprovalToken.findUnique({
        where: { id: hashedId },
      })) ??
      // Legacy compatibility for tokens stored before hashing rollout.
      (await prismaClient.registrationApprovalToken.findUnique({
        where: { id },
      }));

    if (!row) {
      return null;
    }

    return this.toDomain(row);
  }

  async deleteById(id: string): Promise<void> {
    const hashedId = hashRegistrationToken(id);
    await prismaClient.registrationApprovalToken.deleteMany({
      where: {
        OR: [{ id: hashedId }, { id }],
      },
    });
  }

  private toDomain(row: PrismaToken): RegistrationApprovalToken {
    return new RegistrationApprovalToken({
      id: row.id,
      userId: row.userId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    });
  }
}
