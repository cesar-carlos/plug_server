import { Client } from "../../domain/entities/client.entity";

export const buildClientWithRotatedCredentials = (
  client: Client,
  passwordHash: string,
  at: Date = new Date(),
): Client =>
  new Client({
    ...client.withPasswordHash(passwordHash),
    credentialsUpdatedAt: at,
    updatedAt: at,
  });

export const clientCredentialRotationUpdate = (
  passwordHash: string,
  at: Date = new Date(),
): { passwordHash: string; credentialsUpdatedAt: Date; updatedAt: Date } => ({
  passwordHash,
  credentialsUpdatedAt: at,
  updatedAt: at,
});
