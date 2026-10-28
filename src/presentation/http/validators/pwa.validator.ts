import { isAllowedPwaPushEndpoint } from "../../../domain/policies/pwa_push_endpoint.policy";
import { z } from "zod";
export const pwaOfflineAuthorizationBody = z.strictObject({
  agentIds: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
});

export const pwaInstallationParams = z.strictObject({ installationId: z.uuid() });
export const pwaSubscriptionBody = z.strictObject({
  endpoint: z.url().max(2048).refine(isAllowedPwaPushEndpoint),
  keys: z.strictObject({
    p256dh: z
      .string()
      .regex(/^[A-Za-z0-9_-]{87}$/)
      .refine(
        (value) =>
          Buffer.from(value, "base64url").length === 65 && Buffer.from(value, "base64url")[0] === 4,
      ),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});
