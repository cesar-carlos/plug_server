import { randomBytes } from "node:crypto";

/** Opaque URL-safe token for client password recovery links (32 bytes entropy). */
export const generateOpaqueClientPasswordRecoveryToken = (): string => {
  return randomBytes(32).toString("base64url");
};
