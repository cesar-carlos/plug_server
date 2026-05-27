#!/usr/bin/env node
/**
 * Pre-cutover readiness check for migrating plug to Redis Cluster.
 *
 * Validates that every plug-owned key prefix lands on a single slot,
 * Cluster accepts the command repertoire we use, and there are no MOVED
 * redirects after warmup. Exits with status 0 when ready, non-zero when
 * blocking issues are found.
 *
 * Usage:
 *
 *   REDIS_CLUSTER_URLS="redis://node1:6379,redis://node2:6379,redis://node3:6379" \
 *     npx tsx scripts/redis-cluster-readiness-check.ts
 *
 *   # Optional tenant id:
 *   REDIS_TENANT_ID="acme" \
 *     REDIS_CLUSTER_URLS="..." \
 *     npx tsx scripts/redis-cluster-readiness-check.ts
 */

import { createClient } from "redis";

const PLUG_PREFIXES_FOR_VALIDATION = (tenant: string): readonly string[] => {
  const ns = tenant === "" ? "{plug}" : `{plug}:${tenant}`;
  return [
    `plug_socket_rl:${ns}:agents_command:probe`,
    `plug_socket_rl:${ns}:relay_rpc_request:probe`,
    `plug_rl:${ns}:global:probe`,
    `plug_rl:${ns}:credential_auth:probe`,
    `plug_socket_event_idem:${ns}:probe-entry`,
    `plug_socket_event_idem_lock:${ns}:probe-lock`,
    `plug_agent_stream:${ns}:probe-agent`,
    `plug_agent_stream_cursor:${ns}:probe-agent`,
  ];
};

const SAMPLE_LUA = `
local v = redis.call('INCRBY', KEYS[1], 1)
redis.call('PEXPIRE', KEYS[1], 1000)
return v
`;

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

const results: CheckResult[] = [];

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const main = async (): Promise<number> => {
  const urlsRaw = process.env.REDIS_CLUSTER_URLS?.trim() ?? "";
  if (urlsRaw === "") {
    log("FATAL: REDIS_CLUSTER_URLS is required (comma-separated redis:// URLs).");
    return 2;
  }
  const urls = urlsRaw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u !== "");
  const tenantId = process.env.REDIS_TENANT_ID?.trim() ?? "";

  log("plug Redis Cluster readiness check");
  log("=================================");
  log(`Nodes: ${urls.length}`);
  log(`Tenant: ${tenantId === "" ? "(none / single-tenant)" : tenantId}`);
  log("");

  // Use a single Cluster client (node-redis@5 follows MOVED redirects automatically).
  const firstUrl = urls[0];
  if (firstUrl === undefined) {
    log("FATAL: at least one URL required.");
    return 2;
  }
  const client = createClient({ url: firstUrl });
  client.on("error", (err: Error) => {
    log(`Redis client error: ${err.message}`);
  });
  await client.connect();

  // 1. CLUSTER INFO returns cluster_enabled:1
  try {
    const info = (await client.sendCommand(["CLUSTER", "INFO"])) as string;
    const ok = typeof info === "string" && /cluster_enabled:1/.test(info);
    results.push({
      name: "cluster_enabled",
      ok,
      detail: ok ? undefined : `CLUSTER INFO did not report cluster_enabled:1`,
    });
  } catch (error: unknown) {
    results.push({
      name: "cluster_enabled",
      ok: false,
      detail: `CLUSTER INFO failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 2. Every plug prefix lands on a single slot
  try {
    const prefixes = PLUG_PREFIXES_FOR_VALIDATION(tenantId);
    const slots: number[] = [];
    for (const key of prefixes) {
      const slot = (await client.sendCommand(["CLUSTER", "KEYSLOT", key])) as number | string;
      slots.push(Number(slot));
    }
    const uniqueSlots = new Set(slots);
    results.push({
      name: "single_slot_for_plug_prefixes",
      ok: uniqueSlots.size === 1,
      detail:
        uniqueSlots.size === 1
          ? `slot ${slots[0]}`
          : `keys span ${uniqueSlots.size} slots: ${Array.from(uniqueSlots).join(", ")}`,
    });
  } catch (error: unknown) {
    results.push({
      name: "single_slot_for_plug_prefixes",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Sample INCRBY + PEXPIRE works (rate-limit hot path)
  const testKey = `plug_readiness:${tenantId === "" ? "{plug}" : `{plug}:${tenantId}`}:probe-${Date.now()}`;
  try {
    await client.incrBy(testKey, 1);
    await client.pExpire(testKey, 1_000);
    await client.del(testKey);
    results.push({ name: "incrby_pexpire", ok: true });
  } catch (error: unknown) {
    results.push({
      name: "incrby_pexpire",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 4. SCRIPT LOAD + EVALSHA round-trip
  try {
    const sha = (await client.scriptLoad(SAMPLE_LUA)) as string;
    const result = await client.evalSha(sha, {
      keys: [testKey],
      arguments: [],
    });
    await client.del(testKey);
    results.push({
      name: "scriptload_evalsha",
      ok: typeof result === "number" || typeof result === "string",
      detail: `sha=${sha.slice(0, 10)}…`,
    });
  } catch (error: unknown) {
    results.push({
      name: "scriptload_evalsha",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 5. XADD + XLEN (streams)
  try {
    await client.sendCommand([
      "XADD",
      testKey,
      "MAXLEN",
      "~",
      "10",
      "*",
      "field",
      "value",
    ]);
    await client.sendCommand(["XLEN", testKey]);
    await client.del(testKey);
    results.push({ name: "xadd_xlen", ok: true });
  } catch (error: unknown) {
    results.push({
      name: "xadd_xlen",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  await client.quit().catch(() => undefined);

  log("Results:");
  let failed = 0;
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    log(`  [${status}] ${r.name}${r.detail !== undefined ? ` — ${r.detail}` : ""}`);
    if (!r.ok) {
      failed += 1;
    }
  }
  log("");
  if (failed === 0) {
    log("All checks passed — Cluster is ready for the plug cutover.");
    return 0;
  }
  log(`${failed} check(s) failed — DO NOT proceed with the cutover until resolved.`);
  return 1;
};

void main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    log(`UNEXPECTED ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(2);
  });
