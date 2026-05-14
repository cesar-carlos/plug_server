import { User, type UserRole, type UserStatus } from "../../domain/entities/user.entity";
import type {
  IRegistrationDecisionTxn,
  RegistrationDecisionResult,
} from "../../domain/ports/registration_decision_txn.port";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";
import { runPrismaTransactionWithRetry } from "./prisma_transaction_retry";

type UserDecision = "approve" | "reject";

interface TokenRow {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly celular: string | null;
  readonly passwordHash: string;
  readonly credentialsUpdatedAt: Date;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: Date;
}

export class PrismaRegistrationDecisionTxn implements IRegistrationDecisionTxn {
  async approve(tokenId: string): Promise<RegistrationDecisionResult> {
    return this.decide(tokenId, "approve");
  }

  async reject(tokenId: string): Promise<RegistrationDecisionResult> {
    return this.decide(tokenId, "reject");
  }

  private async decide(
    tokenId: string,
    decision: UserDecision,
  ): Promise<RegistrationDecisionResult> {
    const hashedTokenId = hashRegistrationToken(tokenId);
    const nextStatus: UserStatus = decision === "approve" ? "active" : "rejected";

    return runPrismaTransactionWithRetry("registration_decision", () =>
      prismaClient.$transaction(async (tx) => {
        const tokens = await tx.$queryRaw<TokenRow[]>`
        SELECT
          id,
          user_id AS "userId",
          expires_at AS "expiresAt"
        FROM registration_approval_tokens
        WHERE id IN (${hashedTokenId}, ${tokenId})
        FOR UPDATE
      `;
        const token = tokens[0];
        if (!token) {
          return { status: "not_found" };
        }

        if (token.expiresAt.getTime() < Date.now()) {
          await tx.registrationApprovalToken.deleteMany({ where: { id: token.id } });
          return { status: "expired" };
        }

        const users = await tx.$queryRaw<UserRow[]>`
        SELECT
          id,
          email,
          celular,
          password_hash AS "passwordHash",
          credentials_updated_at AS "credentialsUpdatedAt",
          role,
          status,
          created_at AS "createdAt"
        FROM users
        WHERE id = ${token.userId}
        FOR UPDATE
      `;
        const user = users[0];
        if (!user) {
          await tx.registrationApprovalToken.deleteMany({ where: { id: token.id } });
          return { status: "user_not_found" };
        }

        if (user.status !== "pending") {
          await tx.registrationApprovalToken.deleteMany({ where: { id: token.id } });
          return { status: "not_pending" };
        }

        const updatedUsers = await tx.$queryRaw<UserRow[]>`
        UPDATE users
        SET status = ${nextStatus}::"UserStatus"
        WHERE id = ${user.id}
          AND status = 'pending'::"UserStatus"
        RETURNING
          id,
          email,
          celular,
          password_hash AS "passwordHash",
          credentials_updated_at AS "credentialsUpdatedAt",
          role,
          status,
          created_at AS "createdAt"
      `;
        const updatedUser = updatedUsers[0];
        if (!updatedUser) {
          await tx.registrationApprovalToken.deleteMany({ where: { id: token.id } });
          return { status: "not_pending" };
        }

        await tx.registrationApprovalToken.deleteMany({ where: { id: token.id } });

        return decision === "approve"
          ? { status: "approved", user: this.toDomain(updatedUser) }
          : { status: "rejected", user: this.toDomain(updatedUser) };
      }),
    );
  }

  private toDomain(row: UserRow): User {
    return new User({
      id: row.id,
      email: row.email,
      passwordHash: row.passwordHash,
      credentialsUpdatedAt: row.credentialsUpdatedAt,
      role: row.role,
      status: row.status,
      createdAt: row.createdAt,
      ...(row.celular !== null && row.celular !== "" ? { celular: row.celular } : {}),
    });
  }
}
