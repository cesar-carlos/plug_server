import { createHash } from "node:crypto";

/** Deterministic SHA-256 hash for opaque registration token storage/lookup. */
export const hashRegistrationToken = (token: string): string => {
  return createHash("sha256").update(token).digest("hex");
};
