import type {
  ClientPasswordRecoveryResetResult,
  IClientPasswordRecoveryResetTxn,
} from "../../domain/ports/client_password_recovery_reset_txn.port";
import { clientCredentialRotationUpdate } from "../../shared/utils/client_credential_rotation";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";
import { prismaClient } from "../database/prisma/client";
import { runPrismaTransactionWithRetry } from "./prisma_transaction_retry";

interface TokenRow {
  readonly id: string;
  readonly clientId: string;
  readonly expiresAt: Date;
}

export class PrismaClientPasswordRecoveryResetTxn implements IClientPasswordRecoveryResetTxn {
  async resetByToken(
    tokenId: string,
    passwordHash: string,
  ): Promise<ClientPasswordRecoveryResetResult> {
    const hashedTokenId = hashRegistrationToken(tokenId);
    const updatedAt = new Date();

    return runPrismaTransactionWithRetry("client_password_recovery_reset", () =>
      prismaClient.$transaction(async (tx) => {
        const tokens = await tx.$queryRaw<TokenRow[]>`
          SELECT
            id,
            client_id AS "clientId",
            expires_at AS "expiresAt"
          FROM client_password_recovery_tokens
          WHERE id IN (${hashedTokenId}, ${tokenId})
          FOR UPDATE
        `;
        const token = tokens[0];
        if (!token) {
          return { status: "not_found" };
        }

        if (token.expiresAt.getTime() < Date.now()) {
          await tx.clientPasswordRecoveryToken.deleteMany({ where: { id: token.id } });
          return { status: "expired" };
        }

        const client = await tx.client.findUnique({ where: { id: token.clientId } });
        if (!client) {
          await tx.clientPasswordRecoveryToken.deleteMany({ where: { id: token.id } });
          return { status: "client_not_found" };
        }

        if (client.status !== "active") {
          await tx.clientPasswordRecoveryToken.deleteMany({ where: { id: token.id } });
          return { status: "client_inactive" };
        }

        await tx.client.update({
          where: { id: client.id },
          data: clientCredentialRotationUpdate(passwordHash, updatedAt),
        });
        await tx.clientPasswordRecoveryToken.deleteMany({ where: { id: token.id } });
        await tx.clientRefreshToken.updateMany({
          where: { clientId: client.id, revokedAt: null },
          data: { revokedAt: updatedAt },
        });

        return { status: "success" };
      }),
    );
  }
}
