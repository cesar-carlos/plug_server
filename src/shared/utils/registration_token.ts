import { randomBytes } from "node:crypto";

/** Opaque URL-safe token for registration approval links (32 bytes entropy). */
export const generateOpaqueRegistrationToken = (): string => {
  return randomBytes(32).toString("base64url");
};
