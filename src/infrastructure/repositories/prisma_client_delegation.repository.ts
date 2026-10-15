import type {
  ClientDelegation,
  IClientDelegationRepository,
} from "../../domain/ports/client_delegation.port";
import { randomUUID } from "node:crypto";
import { prismaClient } from "../database/prisma/client";
/** Parameterized SQL and metadata-only audit share the mutation transaction. */
export class PrismaClientDelegationRepository implements IClientDelegationRepository {
  async create(v: ClientDelegation): Promise<void> {
    await prismaClient.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO client_persona_delegations
        (id,client_id,token_hash,audience,persona_id,credentials_updated_at,expires_at,administrative)
        VALUES(${v.id},${v.clientId},${v.tokenHash},${v.audience},${v.personaId},
        ${v.credentialsUpdatedAt},${v.expiresAt},${JSON.stringify(v.administrative)}::jsonb)`;
      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          eventType: "client.persona_delegation.created",
          actorRole: "client",
          payloadJson: {
            clientId: v.clientId,
            personaId: v.personaId,
            delegationId: v.id,
            expiresAt: v.expiresAt.toISOString(),
            administrative: [...v.administrative],
          },
        },
      });
    });
  }
  async findByHash(hash: string): Promise<ClientDelegation | null> {
    const rows = await prismaClient.$queryRaw<
      ClientDelegation[]
    >`SELECT id, client_id AS "clientId",
      token_hash AS "tokenHash", audience, persona_id AS "personaId",
      credentials_updated_at AS "credentialsUpdatedAt", expires_at AS "expiresAt",
      administrative, revoked_at AS "revokedAt" FROM client_persona_delegations WHERE token_hash=${hash}`;
    return rows[0] ?? null;
  }
  async revoke(id: string, clientId: string, now: Date): Promise<boolean> {
    return prismaClient.$transaction(async (tx) => {
      const changed = await tx.$queryRaw<{ personaId: string }[]>`UPDATE client_persona_delegations
        SET revoked_at=${now} WHERE id=${id} AND client_id=${clientId} AND revoked_at IS NULL RETURNING persona_id AS "personaId"`;
      if (changed[0]) {
        await tx.auditEvent.create({
          data: {
            id: randomUUID(),
            eventType: "client.persona_delegation.revoked",
            actorRole: "client",
            payloadJson: { clientId, personaId: changed[0].personaId, delegationId: id },
          },
        });
        return true;
      }
      const existing = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM client_persona_delegations WHERE id=${id} AND client_id=${clientId}`;
      return existing.length === 1;
    });
  }
}
