import type { Client, ClientStatus } from "../../domain/entities/client.entity";
import type { IClientRegistrationRegisterTxn } from "../../domain/ports/client_registration_register_txn.port";
import type { ClientRegistrationApprovalToken } from "../../domain/repositories/client_registration_approval_token.repository.interface";
import type { ClientRegistrationPollToken } from "../../domain/repositories/client_registration_poll_token.repository.interface";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";
import { runPrismaTransactionWithRetry } from "./prisma_transaction_retry";

export class PrismaClientRegistrationRegisterTxn implements IClientRegistrationRegisterTxn {
  async registerPending(input: {
    readonly client: Client;
    readonly approvalToken: ClientRegistrationApprovalToken;
    readonly pollToken: ClientRegistrationPollToken;
  }): Promise<void> {
    const { client, approvalToken, pollToken } = input;
    const hashedApprovalId = hashRegistrationToken(approvalToken.id);
    const hashedPollId = hashRegistrationToken(pollToken.id);

    await runPrismaTransactionWithRetry("client_registration_register", () =>
      prismaClient.$transaction([
        prismaClient.client.create({
          data: {
            id: client.id,
            userId: client.userId,
            email: client.email,
            passwordHash: client.passwordHash,
            name: client.name,
            lastName: client.lastName,
            mobile: client.mobile ?? null,
            thumbnailUrl: client.thumbnailUrl ?? null,
            credentialsUpdatedAt: client.credentialsUpdatedAt,
            status: client.status as ClientStatus,
            createdAt: client.createdAt,
            updatedAt: client.updatedAt,
          },
        }),
        prismaClient.clientRegistrationApprovalToken.create({
          data: {
            id: hashedApprovalId,
            clientId: approvalToken.clientId,
            expiresAt: approvalToken.expiresAt,
            createdAt: approvalToken.createdAt,
          },
        }),
        prismaClient.clientRegistrationPollToken.create({
          data: {
            id: hashedPollId,
            clientId: pollToken.clientId,
            createdAt: pollToken.createdAt,
          },
        }),
      ]),
    );
  }
}
