import { z } from "zod";
const schema = z.object({
  PWA_PUSH_ENABLED: z.enum(["true", "false"]).default("false"),
  PWA_VAPID_PUBLIC_KEY: z.string().default(""),
  PWA_VAPID_PRIVATE_KEY: z.string().default(""),
  PWA_VAPID_SUBJECT: z.string().default(""),
});
export const readPwaConfig = (): {
  enabled: boolean;
  publicKey: string;
  privateKey: string;
  subject: string;
} => {
  const input = schema.parse(process.env);
  const enabled = input.PWA_PUSH_ENABLED === "true";
  if (
    enabled &&
    (!input.PWA_VAPID_PUBLIC_KEY ||
      !input.PWA_VAPID_PRIVATE_KEY ||
      !/^(mailto:|https:\/\/)/.test(input.PWA_VAPID_SUBJECT))
  ) {
    throw new Error("PWA VAPID configuration is required when push is enabled");
  }
  return {
    enabled,
    publicKey: input.PWA_VAPID_PUBLIC_KEY,
    privateKey: input.PWA_VAPID_PRIVATE_KEY,
    subject: input.PWA_VAPID_SUBJECT,
  };
};
