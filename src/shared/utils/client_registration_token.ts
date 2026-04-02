import { randomBytes } from "node:crypto";

/** Opaque URL-safe token for client registration approval links (32 bytes entropy). */
export const generateOpaqueClientRegistrationToken = (): string => {
  return randomBytes(32).toString("base64url");
};
