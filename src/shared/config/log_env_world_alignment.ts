import { URL as NodeURL } from "node:url";

import { env } from "./env";
import { logger } from "../utils/logger";

const isLoopbackHost = (host: string): boolean => {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    h.endsWith(".localhost")
  );
};

const parseDatabaseHostname = (databaseUrl: string): string | null => {
  try {
    const normalized = databaseUrl.replace(/^postgresql:\/\//i, "postgres://");
    return new NodeURL(normalized).hostname || null;
  } catch {
    return null;
  }
};

const parseAppHostname = (appBaseUrl: string): string | null => {
  try {
    return new NodeURL(appBaseUrl).hostname || null;
  } catch {
    return null;
  }
};

/**
 * Warns when `APP_BASE_URL` and `DATABASE_URL` look like different environments
 * (e.g. public API URL with a local Postgres), which breaks approval links and
 * owner lookups across instances.
 */
export const logEnvWorldAlignmentHints = (): void => {
  const dbHost = parseDatabaseHostname(env.databaseUrl);
  const appHost = parseAppHostname(env.appBaseUrl);
  if (!dbHost || !appHost) {
    return;
  }

  const dbLocal = isLoopbackHost(dbHost);
  const appLocal = isLoopbackHost(appHost);
  if (dbLocal === appLocal) {
    return;
  }

  const inProduction = env.nodeEnv === "production";
  logger.warn("env_world_alignment_mismatch", {
    message:
      "APP_BASE_URL host and DATABASE_URL host look like different environments (e.g. local DB vs public site). Approval links and diagnostics may point at the wrong instance.",
    databaseHost: dbHost,
    appBaseUrlHost: appHost,
    databaseLooksLocal: dbLocal,
    appBaseUrlLooksLocal: appLocal,
    ...(inProduction ? { severity: "production_configuration" } : {}),
  });
};
