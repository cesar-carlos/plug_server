import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  APP_NAME: z.string().default("plug_server"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default("*"),
  REQUEST_BODY_LIMIT: z.string().default("1mb"),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16).default("change-me-access-development"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_SECRET: z.string().min(16).default("change-me-refresh-development"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  JWT_ISSUER: z.string().min(1).default("plug_server"),
  JWT_AUDIENCE: z.string().min(1).default("plug_clients"),
  PAYLOAD_SIGNING_KEY: z.string().optional(),
  PAYLOAD_SIGNING_KEY_ID: z.string().optional(),
  SOCKET_AUTH_REQUIRED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SWAGGER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const parsedEnv = envSchema.parse(process.env);
const insecureSecrets = new Set(["change-me-access-development", "change-me-refresh-development"]);

if (parsedEnv.NODE_ENV === "production") {
  if (parsedEnv.CORS_ORIGIN === "*") {
    throw new Error("Invalid production config: CORS_ORIGIN cannot be '*'.");
  }

  if (
    insecureSecrets.has(parsedEnv.JWT_ACCESS_SECRET) ||
    insecureSecrets.has(parsedEnv.JWT_REFRESH_SECRET)
  ) {
    throw new Error("Invalid production config: JWT secrets must be explicitly configured.");
  }
}

export const env = {
  appName: parsedEnv.APP_NAME,
  nodeEnv: parsedEnv.NODE_ENV,
  port: parsedEnv.PORT,
  corsOrigin: parsedEnv.CORS_ORIGIN,
  requestBodyLimit: parsedEnv.REQUEST_BODY_LIMIT,
  databaseUrl: parsedEnv.DATABASE_URL,
  jwtAccessSecret: parsedEnv.JWT_ACCESS_SECRET,
  jwtAccessExpiresIn: parsedEnv.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshSecret: parsedEnv.JWT_REFRESH_SECRET,
  jwtRefreshExpiresIn: parsedEnv.JWT_REFRESH_EXPIRES_IN,
  jwtIssuer: parsedEnv.JWT_ISSUER,
  jwtAudience: parsedEnv.JWT_AUDIENCE,
  payloadSigningKey: parsedEnv.PAYLOAD_SIGNING_KEY,
  payloadSigningKeyId: parsedEnv.PAYLOAD_SIGNING_KEY_ID,
  socketAuthRequired: parsedEnv.SOCKET_AUTH_REQUIRED,
  swaggerEnabled: parsedEnv.SWAGGER_ENABLED,
} as const;
