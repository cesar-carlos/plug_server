import { randomBytes } from "node:crypto";

/** Opaque URL-safe token for client agent access approval links (32 bytes entropy). */
export const generateOpaqueClientAccessToken = (): string => {
  return randomBytes(32).toString("base64url");
};
