import { legacyArray } from "../../../shared/validators/legacy_array";
import { z } from "zod";
import { CLIENT_ADMINISTRATIVE_PERMISSIONS } from "../../../domain/ports/client_delegation.port";
export const clientDelegationBinding = z.strictObject({
  audience: z
    .url()
    .max(2048)
    .refine((v) => {
      const u = new URL(v);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === "/" &&
        u.origin === v
      );
    }),
  personaId: z.uuid(),
});
export const clientDelegationBody = clientDelegationBinding.extend({
  administrative: legacyArray(z.enum(CLIENT_ADMINISTRATIVE_PERMISSIONS))
    .min(1)
    .max(5)
    .refine((v) => new Set(v).size === v.length)
    .default(["gerenciar_fontes"]),
});
export const clientDelegationParams = z.strictObject({ id: z.uuid() });
export const clientDelegationVerifyHeaders = z.object({
  authorization: z.string().regex(/^Bearer pdv2_[A-Za-z0-9_-]{43}$/),
});
