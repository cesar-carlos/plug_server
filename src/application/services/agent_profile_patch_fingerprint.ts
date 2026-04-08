import { createHash } from "node:crypto";

import type { AgentSelfProfilePatch } from "./agent_self_profile.service";

const sortKeysDeep = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    out[key] = sortKeysDeep(obj[key]);
  }
  return out;
};

export const fingerprintAgentProfilePatch = (patch: AgentSelfProfilePatch): string => {
  const normalized = sortKeysDeep(patch as unknown as Record<string, unknown>);
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json, "utf8").digest("hex");
};
