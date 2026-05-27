#!/usr/bin/env node
/**
 * Redis capacity planner CLI for the agent_event_stream backlog.
 *
 * Usage:
 *   npx tsx scripts/redis-capacity-planner.ts \
 *     --agents 5000 --max-len 1000 --avg-frame-bytes 1024 --ttl-hours 24
 *
 * Outputs steady-state and burst memory estimates plus operator
 * recommendations (`maxmemory`, eviction policy, separate DB).
 */

interface Args {
  readonly agents: number;
  readonly maxLen: number;
  readonly avgFrameBytes: number;
  readonly ttlHours: number;
  /** Fraction of agents that are "active" at any moment (0..1). Default 0.3. */
  readonly activeFraction: number;
  /** Burst multiplier for the per-stream memory under abnormal load. Default 1.5. */
  readonly burstMultiplier: number;
}

const REDIS_STREAM_OVERHEAD_PER_ENTRY_BYTES = 80; // skiplist + entry envelope

const DEFAULTS: Args = {
  agents: 1_000,
  maxLen: 1_000,
  avgFrameBytes: 1_024,
  ttlHours: 24,
  activeFraction: 0.3,
  burstMultiplier: 1.5,
};

const parseArgs = (argv: readonly string[]): Args => {
  const out: Record<string, number> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (typeof flag !== "string" || !flag.startsWith("--")) {
      continue;
    }
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      continue;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`Invalid value for --${key}: ${value}`);
      process.exit(2);
    }
    out[key] = parsed;
    i += 1;
  }
  return {
    agents: out.agents ?? DEFAULTS.agents,
    maxLen: out["max-len"] ?? DEFAULTS.maxLen,
    avgFrameBytes: out["avg-frame-bytes"] ?? DEFAULTS.avgFrameBytes,
    ttlHours: out["ttl-hours"] ?? DEFAULTS.ttlHours,
    activeFraction: out["active-fraction"] ?? DEFAULTS.activeFraction,
    burstMultiplier: out["burst-multiplier"] ?? DEFAULTS.burstMultiplier,
  };
};

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = bytes;
  let unitIdx = 0;
  while (scaled >= 1024 && unitIdx < units.length - 1) {
    scaled /= 1024;
    unitIdx += 1;
  }
  return `${scaled.toFixed(2)} ${units[unitIdx]}`;
};

const computeMemory = (
  args: Args,
): {
  readonly perStreamSteady: number;
  readonly steadyState: number;
  readonly burst: number;
  readonly cursorOverhead: number;
  readonly recommendedMaxmemory: number;
} => {
  const perStreamSteady = args.maxLen * (args.avgFrameBytes + REDIS_STREAM_OVERHEAD_PER_ENTRY_BYTES);
  const activeAgents = Math.max(1, Math.round(args.agents * args.activeFraction));
  const steadyState = activeAgents * perStreamSteady;
  const burst = steadyState * args.burstMultiplier;
  // Cursor key per principal: ~80 bytes Redis overhead + ~50 bytes string id.
  const cursorOverhead = args.agents * 130;
  // 25% headroom on top of burst, rounded up to the next 1 GiB.
  const headroom = burst * 1.25 + cursorOverhead;
  const oneGib = 1024 ** 3;
  const recommendedMaxmemory = Math.ceil(headroom / oneGib) * oneGib;
  return { perStreamSteady, steadyState, burst, cursorOverhead, recommendedMaxmemory };
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  const memory = computeMemory(args);
  console.log("Plug agent_event_stream capacity planner");
  console.log("========================================");
  console.log(`Inputs:`);
  console.log(`  agents (total)        : ${args.agents.toLocaleString()}`);
  console.log(`  max_len (per stream)  : ${args.maxLen.toLocaleString()}`);
  console.log(`  avg_frame_bytes       : ${args.avgFrameBytes.toLocaleString()}`);
  console.log(`  ttl_hours             : ${args.ttlHours}`);
  console.log(`  active_fraction       : ${args.activeFraction}`);
  console.log(`  burst_multiplier      : ${args.burstMultiplier}`);
  console.log("");
  console.log(`Estimates:`);
  console.log(`  per-stream (steady)   : ${formatBytes(memory.perStreamSteady)}`);
  console.log(
    `  steady-state total    : ${formatBytes(memory.steadyState)} (${Math.round(args.agents * args.activeFraction).toLocaleString()} active streams)`,
  );
  console.log(`  burst (×${args.burstMultiplier})           : ${formatBytes(memory.burst)}`);
  console.log(`  cursor overhead       : ${formatBytes(memory.cursorOverhead)}`);
  console.log("");
  console.log(`Recommendations:`);
  console.log(
    `  Redis maxmemory       : ${formatBytes(memory.recommendedMaxmemory)} (burst + 25% headroom, rounded to 1 GiB)`,
  );
  console.log(`  maxmemory-policy      : noeviction (do not silently drop backlog frames)`);
  console.log(
    `  separate logical DB   : YES — keep streams off the rate-limit/idempotency DB to avoid eviction conflicts`,
  );
  console.log(`  monitoring            : alert on plug_agent_event_stream_dropped_total > 0`);
  console.log("");
  console.log(`Notes:`);
  console.log(
    `  - Idle streams expire after TTL (${args.ttlHours}h). The "active_fraction" represents`,
  );
  console.log(`    how many agents see traffic in a TTL window, not the headcount.`);
  console.log(`  - Increase max_len when burst delivery exceeds reconnect frequency.`);
  console.log(`  - Lower active_fraction once you measure real cardinality in production.`);
};

main();
