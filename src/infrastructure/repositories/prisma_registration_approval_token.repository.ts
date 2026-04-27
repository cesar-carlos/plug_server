import type { RegistrationApprovalToken as PrismaToken } from "@prisma/client";

import { RegistrationApprovalToken } from "../../domain/entities/registration_approval_token.entity";
import type {
  IRegistrationApprovalTokenRepository,
  RegistrationApprovalReviewSummaryRecord,
} from "../../domain/repositories/registration_approval_token.repository.interface";
import type { User, UserStatus } from "../../domain/entities/user.entity";
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

  async replaceForUserRetry(user: User, token: RegistrationApprovalToken): Promise<void> {
    const hashedId = hashRegistrationToken(token.id);
    await prismaClient.$transaction([
      prismaClient.registrationApprovalToken.deleteMany({
        where: { userId: user.id },
      }),
      prismaClient.registrationApprovalToken.create({
        data: {
          id: hashedId,
          userId: token.userId,
          expiresAt: token.expiresAt,
          createdAt: token.createdAt,
        },
      }),
    ]);
  }

  async findById(id: string): Promise<RegistrationApprovalToken | null> {
    const hashedId = hashRegistrationToken(id);
    const row = await prismaClient.registrationApprovalToken.findFirst({
      where: { OR: [{ id: hashedId }, { id }] },
    });

    if (!row) {
      return null;
    }

    return this.toDomain(row);
  }

  async findReviewSummaryById(
    id: string,
  ): Promise<RegistrationApprovalReviewSummaryRecord | null> {
    const hashedId = hashRegistrationToken(id);
    const row = await prismaClient.registrationApprovalToken.findFirst({
      where: { OR: [{ id: hashedId }, { id }] },
      select: {
        expiresAt: true,
        user: {
          select: {
            email: true,
            status: true,
          },
        },
      },
    });

    if (!row) {
      return null;
    }

    return {
      email: row.user.email,
      status: row.user.status as UserStatus,
      expiresAt: row.expiresAt,
    };
  }

  async deleteById(id: string): Promise<void> {
    const hashedId = hashRegistrationToken(id);
    await prismaClient.registrationApprovalToken.deleteMany({
      where: {
        OR: [{ id: hashedId }, { id }],
      },
    });
  }

  async deleteByUserId(userId: string): Promise<void> {
    await prismaClient.registrationApprovalToken.deleteMany({
      where: { userId },
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
