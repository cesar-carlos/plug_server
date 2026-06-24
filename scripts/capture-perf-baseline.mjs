#!/usr/bin/env node
"use strict";

/**
 * P0 baseline capture — fetches GET /metrics and extracts hub↔agent hot-path gauges.
 * See docs/performance/performance_hub_agent.md § Baseline antes/depois.
 *
 * Usage:
 *   HUB_URL=http://localhost:3000 node scripts/capture-perf-baseline.mjs
 *   HUB_URL=http://localhost:3000 node scripts/capture-perf-baseline.mjs --out baseline-2026-06-24.txt
 */

import { writeFileSync } from "node:fs";

const BASELINE_METRICS = [
  "plug_socket_relay_frame_decode_avg_ms",
  "plug_socket_relay_bridge_encode_avg_ms",
  "plug_socket_relay_outbound_queue_job_duration_p95_ms",
  "plug_socket_relay_body_id_echo_total",
  "plug_socket_bridge_ack_retry_attempts_total",
  "plug_rest_sql_stream_materialize_pulls_total",
  "plug_socket_audit_writes_sample_skipped_total",
  "plug_socket_relay_dispatch_queue_full_rejected_total",
  "plug_socket_relay_outbound_queue_backlog",
  "plug_socket_relay_fast_path_honored_total",
  "plug_socket_relay_fast_path_requested_total",
  "plug_agent_health_poll_total",
  "plug_agent_health_piggyback_used_total",
  "plug_socket_relay_batch_envelopes_accepted_total",
  "plug_socket_relay_batch_envelopes_rejected_total",
];

const parseArgs = () => {
  const args = process.argv.slice(2);
  let outPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out" && args[i + 1]) {
      outPath = args[i + 1];
      i += 1;
    }
  }
  return { outPath };
};

const parseMetricLines = (body) => {
  const values = new Map();
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const space = line.lastIndexOf(" ");
    if (space <= 0) {
      continue;
    }
    const name = line.slice(0, space).trim();
    const rawValue = line.slice(space + 1).trim();
    const value = Number.parseFloat(rawValue);
    if (!Number.isFinite(value)) {
      continue;
    }
    const baseName = name.replace(/\{.*\}$/u, "");
    values.set(baseName, value);
  }
  return values;
};

const hubUrl = (process.env.HUB_URL ?? "http://localhost:3000").replace(/\/$/u, "");
const metricsUrl = `${hubUrl}/metrics`;
const { outPath } = parseArgs();

let response;
try {
  response = await fetch(metricsUrl, { signal: AbortSignal.timeout(15_000) });
} catch (error) {
  console.error(`[perf-baseline] Failed to reach ${metricsUrl}`);
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[perf-baseline] Start the hub or set HUB_URL, then rerun.");
  process.exit(1);
}

if (!response.ok) {
  console.error(`[perf-baseline] GET /metrics returned ${response.status}`);
  process.exit(1);
}

const body = await response.text();
const values = parseMetricLines(body);
const capturedAt = new Date().toISOString();

const lines = [
  `# Hub ↔ agent performance baseline`,
  `# captured_at: ${capturedAt}`,
  `# hub_url: ${hubUrl}`,
  `# traffic_profile: ${process.env.PERF_BASELINE_TRAFFIC_PROFILE ?? "(not set — document manually)"}`,
  `# plug_profile: plug-jsonrpc-profile/2.11.2 (expected when agent aligned)`,
  ``,
  `| metric | value |`,
  `| ------ | ----- |`,
];

for (const name of BASELINE_METRICS) {
  const value = values.has(name) ? String(values.get(name)) : "(missing)";
  lines.push(`| ${name} | ${value} |`);
}

lines.push("");
lines.push("# Optional: run load during capture window");
lines.push("#   npm run load:socket-bridge");
lines.push("#   autocannon against POST /api/v1/agents/commands");

const report = lines.join("\n");
console.log(report);

if (outPath) {
  writeFileSync(outPath, report, "utf8");
  console.error(`[perf-baseline] Wrote ${outPath}`);
}
