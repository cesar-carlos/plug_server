import type { ManagedClientSnapshot } from "../../domain/ports/managed_client_query.port";

export const managedClientSelect = {
  id: true,
  userId: true,
  email: true,
  name: true,
  lastName: true,
  mobile: true,
  thumbnailUrl: true,
  status: true,
} as const;

export const toManagedClientSnapshot = (
  row: Omit<ManagedClientSnapshot, "mobile" | "thumbnailUrl"> & {
    readonly mobile?: string | null;
    readonly thumbnailUrl?: string | null;
  },
): ManagedClientSnapshot => ({
  id: row.id,
  userId: row.userId,
  email: row.email,
  name: row.name,
  lastName: row.lastName,
  status: row.status,
  ...(row.mobile != null ? { mobile: row.mobile } : {}),
  ...(row.thumbnailUrl != null ? { thumbnailUrl: row.thumbnailUrl } : {}),
});
