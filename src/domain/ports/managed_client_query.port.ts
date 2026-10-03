import type { Client } from "../entities/client.entity";
import type { ManagedClientListFilter } from "../repositories/client.repository.interface";

export type ManagedClientSnapshot = Pick<
  Client,
  "id" | "userId" | "email" | "name" | "lastName" | "mobile" | "thumbnailUrl" | "status"
>;
export interface ManagedClientSnapshotPage {
  readonly items: readonly ManagedClientSnapshot[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
export interface IManagedClientQueryPort {
  findManagedClient(clientId: string): Promise<ManagedClientSnapshot | null>;
  listManagedClients(
    userId: string,
    filter?: ManagedClientListFilter,
  ): Promise<ManagedClientSnapshotPage>;
}
