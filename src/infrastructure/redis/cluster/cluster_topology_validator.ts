/**
 * Best-effort Redis Cluster topology validator. Called once per module
 * after `init` to give operators an early signal when:
 *
 *   - The Redis instance is in cluster mode (`cluster_enabled:1`), AND
 *   - The hash-tagged prefixes used by the module would scatter across
 *     multiple slots, breaking multi-key Lua scripts (`CROSSSLOT` errors).
 *
 * The validator never throws: failure modes are logged and operation
 * continues. It exists to surface a misconfiguration earlier than
 * runtime command failures.
 *
 * Standalone Redis (the common case for self-hosted single-node and most
 * managed services like Upstash) returns `cluster_enabled:0` and the
 * validator returns immediately as a no-op.
 */

import { logger } from "../../../shared/utils/logger";
import type { InstrumentedRedisClient } from "../connection/instrumented_redis_client";

export interface ClusterTopologyValidatorInput {
  readonly client: InstrumentedRedisClient;
  /** Stable name for log correlation (e.g. `socket_rate_limit_redis`). */
  readonly logName: string;
  /**
   * Sample keys representing each prefix the module uses. We compute
   * `CLUSTER KEYSLOT <key>` for each and check they all land on the same
   * slot. With the `{plug}` hash tag in place, all keys SHOULD share a slot.
   */
  readonly sampleKeys: readonly string[];
}

const SLOT_LOG_LIMIT = 5;

const isCommandUnsupportedError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message ?? "";
  // Managed services / non-cluster Redis respond with "ERR This instance has cluster support disabled"
  // or similar. We treat any error from CLUSTER INFO as "not cluster, skip".
  return /cluster|not allowed/i.test(message);
};

const parseClusterEnabled = (info: string): boolean => {
  for (const line of info.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "cluster_enabled:1") {
      return true;
    }
    if (trimmed === "cluster_enabled:0") {
      return false;
    }
  }
  return false;
};

const fetchKeySlot = async (
  client: InstrumentedRedisClient,
  key: string,
): Promise<number | undefined> => {
  try {
    const raw = await client.sendCommand(["CLUSTER", "KEYSLOT", key]);
    const slot = Number(raw);
    return Number.isFinite(slot) ? slot : undefined;
  } catch {
    return undefined;
  }
};

export const validateRedisClusterTopology = async (
  input: ClusterTopologyValidatorInput,
): Promise<void> => {
  const { client, logName, sampleKeys } = input;

  let info: string;
  try {
    const raw = await client.sendCommand(["CLUSTER", "INFO"]);
    if (typeof raw !== "string") {
      return;
    }
    info = raw;
  } catch (error: unknown) {
    if (isCommandUnsupportedError(error)) {
      // Standalone or managed service that disables CLUSTER commands. No-op.
      return;
    }
    logger.warn(`${logName}_cluster_info_failed`, {
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!parseClusterEnabled(info)) {
    return;
  }

  if (sampleKeys.length < 2) {
    return;
  }

  const slots = await Promise.all(sampleKeys.map((key) => fetchKeySlot(client, key)));
  const resolved = slots.filter((s): s is number => s !== undefined);
  if (resolved.length < 2) {
    return;
  }

  const distinct = new Set(resolved);
  if (distinct.size === 1) {
    logger.info(`${logName}_cluster_topology_ok`, {
      slot: resolved[0],
      sampleKeys: sampleKeys.slice(0, SLOT_LOG_LIMIT),
    });
    return;
  }

  logger.error(`${logName}_cluster_topology_crossslot`, {
    distinctSlots: Array.from(distinct).sort((a, b) => a - b),
    sampleSlotsBySampleKey: sampleKeys.slice(0, SLOT_LOG_LIMIT).map((key, idx) => ({
      key,
      slot: slots[idx],
    })),
    remediation:
      "Multi-key Lua scripts will fail with CROSSSLOT. Verify that the {plug} hash tag is present in all key prefixes.",
  });
};
