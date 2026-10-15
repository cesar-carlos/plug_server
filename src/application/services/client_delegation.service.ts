import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ClientAdministrativePermission,
  IClientDelegationRepository,
} from "../../domain/ports/client_delegation.port";
import type { IClientRepository } from "../../domain/repositories/client.repository.interface";
import { unauthorized, notFound } from "../../shared/errors/http_errors";

export interface ClientDelegationProof {
  id: string;
  clientId: string;
  audience: string;
  personaId: string;
  expiresAt: string;
  administrative: readonly ClientAdministrativePermission[];
}
/** A delegation proves only an active Client; it cannot route agent commands or approve operations. */
export class ClientDelegationService {
  constructor(
    private readonly repository: IClientDelegationRepository,
    private readonly clients: IClientRepository,
    private readonly now = () => new Date(),
  ) {}
  async create(
    clientId: string,
    input: {
      audience: string;
      personaId: string;
      administrative?: readonly ClientAdministrativePermission[];
    },
  ): Promise<ClientDelegationProof & { credential: string }> {
    const client = await this.clients.findActiveSnapshotById(clientId);
    if (client?.status !== "active") throw unauthorized("Active Client required");
    const credential = "pdv2_" + randomBytes(32).toString("base64url");
    const value = {
      id: randomUUID(),
      clientId,
      administrative: [
        ...new Set<ClientAdministrativePermission>(input.administrative ?? ["gerenciar_fontes"]),
      ],
      audience: input.audience,
      personaId: input.personaId,
      tokenHash: createHash("sha256").update(credential).digest("hex"),
      credentialsUpdatedAt: client.credentialsUpdatedAt,
      expiresAt: new Date(this.now().getTime() + 30 * 86400000),
      revokedAt: null,
    };
    await this.repository.create(value);
    return {
      id: value.id,
      clientId,
      audience: value.audience,
      personaId: value.personaId,
      expiresAt: value.expiresAt.toISOString(),
      administrative: value.administrative,
      credential,
    };
  }
  async verify(
    credential: string,
    input: {
      audience: string;
      personaId: string;
      administrative?: readonly ClientAdministrativePermission[];
    },
  ): Promise<ClientDelegationProof & { active: true }> {
    if (!/^pdv2_[A-Za-z0-9_-]{43}$/.test(credential)) throw unauthorized("Invalid delegation");
    const value = await this.repository.findByHash(
      createHash("sha256").update(credential).digest("hex"),
    );
    if (
      !value ||
      value.revokedAt ||
      value.expiresAt <= this.now() ||
      value.audience !== input.audience ||
      value.personaId !== input.personaId
    )
      throw unauthorized("Invalid delegation");
    const client = await this.clients.findActiveSnapshotById(value.clientId);
    if (
      client?.status !== "active" ||
      client.credentialsUpdatedAt.getTime() !== value.credentialsUpdatedAt.getTime()
    )
      throw unauthorized("Invalid delegation");
    return {
      id: value.id,
      clientId: value.clientId,
      audience: value.audience,
      personaId: value.personaId,
      expiresAt: value.expiresAt.toISOString(),
      administrative: value.administrative,
      active: true as const,
    };
  }
  async revoke(clientId: string, id: string): Promise<void> {
    if (!(await this.repository.revoke(id, clientId, this.now())))
      throw notFound("Delegation unavailable");
  }
}
