import type { RegistrationApprovalToken as PrismaToken } from "@prisma/client";

import { RegistrationApprovalToken } from "../../domain/entities/registration_approval_token.entity";
import type { IRegistrationApprovalTokenRepository } from "../../domain/repositories/registration_approval_token.repository.interface";
import { prismaClient } from "../database/prisma/client";

export class PrismaRegistrationApprovalTokenRepository implements IRegistrationApprovalTokenRepository {
  async save(token: RegistrationApprovalToken): Promise<void> {
    await prismaClient.registrationApprovalToken.upsert({
      where: { id: token.id },
      create: {
        id: token.id,
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
    const row = await prismaClient.registrationApprovalToken.findUnique({
      where: { id },
    });

    if (!row) {
      return null;
    }

    return this.toDomain(row);
  }

  async deleteById(id: string): Promise<void> {
    await prismaClient.registrationApprovalToken.deleteMany({
      where: { id },
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
