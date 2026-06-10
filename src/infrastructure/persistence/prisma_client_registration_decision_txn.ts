import { Client, type ClientStatus } from "../../domain/entities/client.entity";
import type {
  ClientRegistrationDecisionResult,
  IClientRegistrationDecisionTxn,
} from "../../domain/ports/client_registration_decision_txn.port";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";
import { runPrismaTransactionWithRetry } from "./prisma_transaction_retry";

type ClientDecision = "approve" | "reject";

interface TokenRow {
  readonly id: string;
  readonly clientId: string;
  readonly expiresAt: Date;
}

interface ClientRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly name: string;
  readonly lastName: string;
  readonly mobile: string | null;
  readonly thumbnailUrl: string | null;
  readonly credentialsUpdatedAt: Date;
  readonly status: ClientStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface OwnerRow {
  readonly status: string;
}

export class PrismaClientRegistrationDecisionTxn implements IClientRegistrationDecisionTxn {
  async approve(tokenId: string): Promise<ClientRegistrationDecisionResult> {
    return this.decideByToken(tokenId, "approve");
  }

  async reject(tokenId: string): Promise<ClientRegistrationDecisionResult> {
    return this.decideByToken(tokenId, "reject");
  }

  async approveByClientId(clientId: string): Promise<ClientRegistrationDecisionResult> {
    return this.decideByClientId(clientId, "approve");
  }

  async rejectByClientId(clientId: string): Promise<ClientRegistrationDecisionResult> {
    return this.decideByClientId(clientId, "reject");
  }

  private async decideByToken(
    tokenId: string,
    decision: ClientDecision,
  ): Promise<ClientRegistrationDecisionResult> {
    const hashedTokenId = hashRegistrationToken(tokenId);
    const nextStatus: ClientStatus = decision === "approve" ? "active" : "rejected";
    const updatedAt = new Date();

    return runPrismaTransactionWithRetry("client_registration_decision", () =>
      prismaClient.$transaction(async (tx) => {
        const tokens = await tx.$queryRaw<TokenRow[]>`
        SELECT
          id,
          client_id AS "clientId",
          expires_at AS "expiresAt"
        FROM client_registration_approval_tokens
        WHERE id IN (${hashedTokenId}, ${tokenId})
        FOR UPDATE
      `;
        const token = tokens[0];
        if (!token) {
          return { status: "not_found" };
        }

        if (token.expiresAt.getTime() < Date.now()) {
          await tx.clientRegistrationApprovalToken.deleteMany({ where: { id: token.id } });
          return { status: "expired" };
        }

        return this.transitionPendingClient(tx, token.clientId, token.id, nextStatus, updatedAt, decision);
      }),
    );
  }

  private async decideByClientId(
    clientId: string,
    decision: ClientDecision,
  ): Promise<ClientRegistrationDecisionResult> {
    const nextStatus: ClientStatus = decision === "approve" ? "active" : "rejected";
    const updatedAt = new Date();

    return runPrismaTransactionWithRetry("client_registration_decision_by_client", () =>
      prismaClient.$transaction(async (tx) => {
        const approvalTokens = await tx.$queryRaw<TokenRow[]>`
        SELECT
          id,
          client_id AS "clientId",
          expires_at AS "expiresAt"
        FROM client_registration_approval_tokens
        WHERE client_id = ${clientId}
        FOR UPDATE
      `;
        const approvalToken = approvalTokens[0];

        return this.transitionPendingClient(
          tx,
          clientId,
          approvalToken?.id,
          nextStatus,
          updatedAt,
          decision,
        );
      }),
    );
  }

  private async transitionPendingClient(
    tx: Parameters<Parameters<typeof prismaClient.$transaction>[0]>[0],
    clientId: string,
    approvalTokenId: string | undefined,
    nextStatus: ClientStatus,
    updatedAt: Date,
    decision: ClientDecision,
  ): Promise<ClientRegistrationDecisionResult> {
    const clients = await tx.$queryRaw<ClientRow[]>`
      SELECT
        id,
        user_id AS "userId",
        email,
        password_hash AS "passwordHash",
        name,
        last_name AS "lastName",
        mobile,
        thumbnail_url AS "thumbnailUrl",
        credentials_updated_at AS "credentialsUpdatedAt",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM clients
      WHERE id = ${clientId}
      FOR UPDATE
    `;
    const client = clients[0];
    if (!client) {
      if (approvalTokenId) {
        await tx.clientRegistrationApprovalToken.deleteMany({ where: { id: approvalTokenId } });
      }
      return { status: "client_not_found" };
    }

    const owners = await tx.$queryRaw<OwnerRow[]>`
      SELECT status
      FROM users
      WHERE id = ${client.userId}
      FOR UPDATE
    `;
    const owner = owners[0];
    if (!owner || owner.status !== "active") {
      return { status: "owner_inactive" };
    }

    if (client.status !== "pending") {
      if (approvalTokenId) {
        await tx.clientRegistrationApprovalToken.deleteMany({ where: { id: approvalTokenId } });
      }
      return { status: "not_pending" };
    }

    const updatedClients = await tx.$queryRaw<ClientRow[]>`
      UPDATE clients
      SET
        status = ${nextStatus}::"ClientStatus",
        updated_at = ${updatedAt}
      WHERE id = ${client.id}
        AND status = 'pending'::"ClientStatus"
      RETURNING
        id,
        user_id AS "userId",
        email,
        password_hash AS "passwordHash",
        name,
        last_name AS "lastName",
        mobile,
        thumbnail_url AS "thumbnailUrl",
        credentials_updated_at AS "credentialsUpdatedAt",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const updatedClient = updatedClients[0];
    if (!updatedClient) {
      if (approvalTokenId) {
        await tx.clientRegistrationApprovalToken.deleteMany({ where: { id: approvalTokenId } });
      }
      return { status: "not_pending" };
    }

    await tx.clientRegistrationApprovalToken.deleteMany({ where: { clientId: client.id } });

    return decision === "approve"
      ? { status: "approved", client: this.toDomain(updatedClient) }
      : { status: "rejected", client: this.toDomain(updatedClient) };
  }

  private toDomain(row: ClientRow): Client {
    return new Client({
      id: row.id,
      userId: row.userId,
      email: row.email,
      passwordHash: row.passwordHash,
      name: row.name,
      lastName: row.lastName,
      ...(row.mobile !== null && row.mobile !== "" ? { mobile: row.mobile } : {}),
      ...(row.thumbnailUrl !== null && row.thumbnailUrl !== ""
        ? { thumbnailUrl: row.thumbnailUrl }
        : {}),
      credentialsUpdatedAt: row.credentialsUpdatedAt,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
