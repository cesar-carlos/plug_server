export const CLIENT_ADMINISTRATIVE_PERMISSIONS = [
  "treinar",
  "publicar",
  "gerenciar_fontes",
  "gerenciar_tokens",
  "gerenciar_integracoes",
] as const;
export type ClientAdministrativePermission = (typeof CLIENT_ADMINISTRATIVE_PERMISSIONS)[number];

export interface ClientDelegation {
  readonly administrative: readonly ClientAdministrativePermission[];
  readonly id: string;
  readonly clientId: string;
  readonly tokenHash: string;
  readonly audience: string;
  readonly personaId: string;
  readonly credentialsUpdatedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}
export interface IClientDelegationRepository {
  create(value: ClientDelegation): Promise<void>;
  findByHash(hash: string): Promise<ClientDelegation | null>;
  revoke(id: string, clientId: string, now: Date): Promise<boolean>;
}
