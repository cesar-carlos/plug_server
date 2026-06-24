#!/usr/bin/env node
"use strict";

/**
 * P1 performance env audit — compares process.env (after dotenv) against
 * recommended presets from docs/performance/performance_hub_agent.md.
 *
 * Usage:
 *   node scripts/audit-perf-env.mjs
 *   node scripts/audit-perf-env.mjs --strict   # exit 1 on any warning
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  const dotenv = await import("dotenv");
  dotenv.config({ path: envPath, quiet: true });
}

const strict = process.argv.includes("--strict");
const nodeEnv = (process.env.NODE_ENV ?? "development").trim();

const checks = [
  {
    key: "SOCKET_IO_TRANSPORTS",
    recommend: "websocket",
    reason: "WS-only reduces handshake and polling overhead in production",
    productionOnly: true,
  },
  {
    key: "SOCKET_IO_HTTP_COMPRESSION",
    recommend: "false",
    reason: "Avoid zlib on Engine.IO when using PayloadFrame gzip",
    productionOnly: true,
  },
  {
    key: "SOCKET_IO_PER_MESSAGE_DEFLATE",
    recommend: "false",
    reason: "Avoid double compression on WebSocket frames",
  },
  {
    key: "PAYLOAD_FRAME_GZIP_LEVEL",
    recommendRange: [1, 3],
    reason: "Lower CPU for hub gzip (1–3); production default is 3 when unset",
    optional: true,
  },
  {
    key: "PAYLOAD_FRAME_ASYNC_GZIP_MIN_UTF8_BYTES",
    recommend: "65536",
    preset: "event-loop",
    reason: "Earlier async gzip for medium/large outbound frames",
    optional: true,
  },
  {
    key: "PAYLOAD_FRAME_ASYNC_GUNZIP_MIN_COMPRESSED_BYTES",
    recommend: "32768",
    preset: "event-loop",
    reason: "Earlier async gunzip for inbound agent responses",
    optional: true,
  },
  {
    key: "SOCKET_REST_STREAM_PULL_WINDOW_SIZE",
    recommend: "512",
    preset: "high-throughput",
    reason: "Fewer REST materializer round-trips (more RAM)",
    optional: true,
  },
  {
    key: "SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT",
    recommendRange: [10, 25],
    preset: "high-throughput",
    reason: "Reduce audit CPU on relay:rpc.chunk at scale",
    optional: true,
  },
  {
    key: "SOCKET_RELAY_BATCH_ENABLED",
    recommend: "true",
    preset: "staging-relay-batch",
    reason: "Enable relay:rpc.request.batch for Colmeia (P3)",
    optional: true,
  },
];

const readValue = (key) => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  return raw.trim();
};

const inRange = (value, min, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max;
};

let warnings = 0;
let ok = 0;
let skipped = 0;

console.log(`[perf-env-audit] NODE_ENV=${nodeEnv}`);
console.log(`[perf-env-audit] .env ${existsSync(envPath) ? "loaded" : "not found (process env only)"}`);
console.log("");

for (const check of checks) {
  if (check.productionOnly && nodeEnv !== "production") {
    skipped += 1;
    console.log(`SKIP  ${check.key} (production-only check)`);
    continue;
  }

  const value = readValue(check.key);
  if (value === null) {
    if (check.optional) {
      skipped += 1;
      console.log(`INFO  ${check.key} unset — using env.ts default`);
      continue;
    }
    if (nodeEnv === "production" && check.productionOnly) {
      console.log(`OK    ${check.key} unset — env.ts production default may apply`);
      ok += 1;
      continue;
    }
    warnings += 1;
    console.log(`WARN  ${check.key} unset — ${check.reason}`);
    continue;
  }

  if (check.recommend !== undefined && value !== check.recommend) {
    warnings += 1;
    console.log(
      `WARN  ${check.key}=${value} — recommend ${check.recommend} (${check.reason})`,
    );
    continue;
  }

  if (check.recommendRange && !inRange(value, check.recommendRange[0], check.recommendRange[1])) {
    warnings += 1;
    console.log(
      `WARN  ${check.key}=${value} — recommend ${check.recommendRange[0]}–${check.recommendRange[1]} (${check.reason})`,
    );
    continue;
  }

  ok += 1;
  console.log(`OK    ${check.key}=${value}`);
}

console.log("");
console.log(`[perf-env-audit] ok=${ok} warnings=${warnings} skipped=${skipped}`);
console.log("[perf-env-audit] See docs/performance/performance_hub_agent.md for presets");

if (strict && warnings > 0) {
  process.exit(1);
}
