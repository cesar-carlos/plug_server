"use strict";

/**
 * Runs Vitest e2e suite only when E2E_TESTS_ENABLED=true (after loading .env).
 * Exit 0 when skipped so CI/scripts can call npm run test:e2e unconditionally.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");

const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });

if (process.env.E2E_TESTS_ENABLED !== "true") {
  console.log(
    "[test:e2e] Skipped: set E2E_TESTS_ENABLED=true in .env (see .env.example).",
  );
  process.exit(0);
}

const redactDatabaseUrl = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<invalid DATABASE_URL>";
  }
};

const logLiveSuiteStatus = async () => {
  const liveAgentId = process.env.E2E_LIVE_AGENT_ID?.trim();
  if (!liveAgentId) {
    console.log(
      "[test:e2e] Live suite skipped: set E2E_LIVE_AGENT_ID (and optionally E2E_LIVE_HUB_URL) in .env.",
    );
    return;
  }

  const hubUrl = (
    process.env.E2E_LIVE_HUB_URL ?? "https://plug-server.se7esistemassinop.com.br"
  ).replace(/\/$/, "");
  console.log(`[test:e2e] Live suite enabled: agent=${liveAgentId} hub=${hubUrl}`);

  try {
    const response = await fetch(`${hubUrl}/api/v1/health/ready`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.warn(`[test:e2e] Live hub not ready (HTTP ${response.status}); live tests may fail.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[test:e2e] Live hub unreachable at ${hubUrl}: ${message}`);
  }
};

const ensureDatabaseIsReady = async () => {
  const prisma = new PrismaClient({
    log: ["error"],
  });
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "[test:e2e] Prisma database preflight failed. The E2E suite needs a reachable Postgres before boot.",
    );
    console.error(`[test:e2e] DATABASE_URL=${redactDatabaseUrl(process.env.DATABASE_URL ?? "")}`);
    console.error("[test:e2e] Try `npm run db:container:up` (or start your own Postgres) and rerun `npm run test:e2e`.");
    console.error(`[test:e2e] Underlying error: ${message}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
};

const run = async () => {
  await ensureDatabaseIsReady();
  await logLiveSuiteStatus();

  const vitestCli = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(process.execPath, [vitestCli, "run", "-c", "vitest.e2e.config.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
};

void run();
