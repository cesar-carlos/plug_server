import { z } from "zod";
export const expectedSourceSchema = z.strictObject({
  version: z.literal(1),
  dialect: z.enum(["postgres", "mssql", "sybase"]),
  identityHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const sourceDiscoveryParamsSchema = z.strictObject({
  contractVersion: z.literal(1),
  database: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^;{}\r\n\0]+$/),
  client_token: z.string().min(1).max(8192),
});
export const sourceDiscoveryResultSchema = z.strictObject({
  contractVersion: z.literal(1),
  database: z.string().min(1).max(500),
  dialect: z.enum(["postgres", "mssql", "sybase"]),
  identityHash: z.string().regex(/^[a-f0-9]{64}$/),
  identityKind: z.enum(["native", "provisioned", "locator"]),
  engineVersion: z.string().max(200),
  verifiedAt: z.string().datetime({ offset: true }),
});
