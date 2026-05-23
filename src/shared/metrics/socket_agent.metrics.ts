/**
 * Counters for `/agents` Socket.IO namespace runtime signals.
 * Exposed via GET /metrics through `getSocketMetricsSnapshot`.
 */

import { HUB_TRANSPORT_EXTENSIONS } from "../constants/agent_transport_contract";
import { isRecord } from "../utils/rpc_types";

export type AgentSocketAuthRejectReason =
  | "missing_token"
  | "invalid_token"
  | "role_denied"
  | "blocked_account"
  | "account_validation_error";

const authRejects: Record<AgentSocketAuthRejectReason, number> = {
  missing_token: 0,
  invalid_token: 0,
  role_denied: 0,
  blocked_account: 0,
  account_validation_error: 0,
};

let sessionRejectedActiveTotal = 0;
let sessionTakeoverDisconnectTotal = 0;
let sessionRegisterRateLimitedTotal = 0;
let agentIdleTimeoutDisconnectTotal = 0;
let agentReadyLegacyPayloadTotal = 0;
let agentReadyInvalidPartialPayloadTotal = 0;

const inboundContractValidation = {
  failedTotal: 0,
  warnTotal: 0,
};

const capabilityProfiles = {
  current: 0,
  older: 0,
  unknown: 0,
};

let capabilityAgentGetHealthCapableTotal = 0;

const agentHealth = {
  responsesTotal: 0,
  errorsTotal: 0,
  lastSeenAtMs: 0,
  lastHealthy: 0,
  lastDegraded: 0,
  lastUptimeSeconds: 0,
  lastSqlQueueCurrentSize: 0,
  lastSqlQueueMaxSize: 0,
  lastActiveWorkers: 0,
  lastMaxWorkers: 0,
  lastSqlQueueRejectionsTotal: 0,
  lastSqlQueueTimeoutsTotal: 0,
  lastSqlQueueAvgWaitTimeMs: 0,
  lastQueryTotal: 0,
  lastQueryErrors: 0,
  lastQuerySuccessRate: 0,
  lastAvgLatencyMs: 0,
  lastP95LatencyMs: 0,
  lastP99LatencyMs: 0,
};

interface PlugProfileVersion {
  readonly major: number;
  readonly minor: number;
}

const readProfileString = (capabilities: Record<string, unknown>): string | null => {
  const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : null;
  const profile =
    extensions?.plugProfile ??
    extensions?.plug_profile ??
    capabilities.plugProfile ??
    capabilities.plug_profile;

  return typeof profile === "string" && profile.trim() !== "" ? profile.trim() : null;
};

const readPlugProfileVersion = (profile: string | null): PlugProfileVersion | null => {
  if (!profile) {
    return null;
  }
  const match = /plug-jsonrpc-profile\/(\d+)\.(\d+)/u.exec(profile);
  const majorText = match?.[1];
  const minorText = match?.[2];
  if (!majorText || !minorText) {
    return null;
  }
  const major = Number.parseInt(majorText, 10);
  const minor = Number.parseInt(minorText, 10);
  return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : null;
};

const currentPlugProfileVersion = readPlugProfileVersion(HUB_TRANSPORT_EXTENSIONS.plugProfile);

const isAtLeastPlugProfileVersion = (
  version: PlugProfileVersion,
  target: PlugProfileVersion,
): boolean => {
  if (version.major !== target.major) {
    return version.major > target.major;
  }

  return version.minor >= target.minor;
};

const readNumber = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const pickNumber = (
  source: Record<string, unknown> | null,
  keys: readonly string[],
): number | null => {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = readNumber(source[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
};

export const noteAgentSocketAuthRejected = (reason: AgentSocketAuthRejectReason): void => {
  authRejects[reason] += 1;
};

export const noteAgentSessionRejectedActive = (): void => {
  sessionRejectedActiveTotal += 1;
};

export const noteAgentSessionTakeoverDisconnect = (): void => {
  sessionTakeoverDisconnectTotal += 1;
};

export const noteAgentIdleTimeoutDisconnect = (count = 1): void => {
  if (count > 0) {
    agentIdleTimeoutDisconnectTotal += count;
  }
};

export const noteAgentRegisterRateLimited = (): void => {
  sessionRegisterRateLimitedTotal += 1;
};

export const noteAgentReadyLegacyPayload = (): void => {
  agentReadyLegacyPayloadTotal += 1;
};

export const noteAgentReadyInvalidPartialPayload = (): void => {
  agentReadyInvalidPartialPayloadTotal += 1;
};

export const noteAgentInboundContractValidationFailed = (mode: "strict" | "warn"): void => {
  inboundContractValidation.failedTotal += 1;
  if (mode === "warn") {
    inboundContractValidation.warnTotal += 1;
  }
};

export const noteAgentCapabilityProfile = (capabilities: Record<string, unknown>): void => {
  const version = readPlugProfileVersion(readProfileString(capabilities));
  if (!version || !currentPlugProfileVersion) {
    capabilityProfiles.unknown += 1;
    return;
  }

  if (isAtLeastPlugProfileVersion(version, currentPlugProfileVersion)) {
    capabilityProfiles.current += 1;
  } else {
    capabilityProfiles.older += 1;
  }

  if (isAtLeastPlugProfileVersion(version, { major: 2, minor: 9 })) {
    capabilityAgentGetHealthCapableTotal += 1;
  }
};

export const noteAgentHealthRpcResponse = (response: unknown): void => {
  if (!isRecord(response) || isRecord(response.error)) {
    agentHealth.errorsTotal += 1;
    return;
  }

  const result = isRecord(response.result) ? response.result : null;
  if (!result) {
    agentHealth.errorsTotal += 1;
    return;
  }

  const status = typeof result.status === "string" ? result.status : "";
  const sqlQueue = isRecord(result.sql_queue) ? result.sql_queue : null;
  const queries = isRecord(result.queries) ? result.queries : null;
  const latency = isRecord(result.latency_ms) ? result.latency_ms : null;

  agentHealth.responsesTotal += 1;
  agentHealth.lastSeenAtMs = Date.now();
  agentHealth.lastHealthy = status === "healthy" ? 1 : 0;
  agentHealth.lastDegraded = status === "degraded" ? 1 : 0;
  agentHealth.lastUptimeSeconds = pickNumber(result, ["uptime_seconds", "uptimeSeconds"]) ?? 0;
  agentHealth.lastSqlQueueCurrentSize =
    pickNumber(sqlQueue, ["current_size", "currentSize", "pending"]) ?? 0;
  agentHealth.lastSqlQueueMaxSize = pickNumber(sqlQueue, ["max_size", "maxSize", "capacity"]) ?? 0;
  agentHealth.lastActiveWorkers =
    pickNumber(sqlQueue, ["active_workers", "activeWorkers", "active"]) ?? 0;
  agentHealth.lastMaxWorkers = pickNumber(sqlQueue, ["max_workers", "maxWorkers"]) ?? 0;
  agentHealth.lastSqlQueueRejectionsTotal =
    pickNumber(sqlQueue, ["rejections_total", "rejectionsTotal"]) ?? 0;
  agentHealth.lastSqlQueueTimeoutsTotal =
    pickNumber(sqlQueue, ["timeouts_total", "timeoutsTotal"]) ?? 0;
  agentHealth.lastSqlQueueAvgWaitTimeMs =
    pickNumber(sqlQueue, ["avg_wait_time_ms", "avgWaitTimeMs"]) ?? 0;
  agentHealth.lastQueryTotal = pickNumber(queries, ["total"]) ?? 0;
  agentHealth.lastQueryErrors = pickNumber(queries, ["errors"]) ?? 0;
  agentHealth.lastQuerySuccessRate = pickNumber(queries, ["success_rate", "successRate"]) ?? 0;
  agentHealth.lastAvgLatencyMs = pickNumber(queries, ["avg_latency_ms", "avgLatencyMs"]) ?? 0;
  agentHealth.lastP95LatencyMs =
    pickNumber(queries, ["p95_latency_ms", "p95LatencyMs"]) ??
    pickNumber(latency, ["p95", "p95_ms", "p95Ms"]) ??
    0;
  agentHealth.lastP99LatencyMs =
    pickNumber(queries, ["p99_latency_ms", "p99LatencyMs"]) ??
    pickNumber(latency, ["p99", "p99_ms", "p99Ms"]) ??
    0;
};

export const getSocketAgentMetricsSnapshot = (): {
  readonly authRejects: typeof authRejects;
  readonly sessionRejectedActiveTotal: number;
  readonly sessionTakeoverDisconnectTotal: number;
  readonly agentIdleTimeoutDisconnectTotal: number;
  readonly sessionRegisterRateLimitedTotal: number;
  readonly agentReadyLegacyPayloadTotal: number;
  readonly agentReadyInvalidPartialPayloadTotal: number;
  readonly inboundContractValidation: typeof inboundContractValidation;
  readonly capabilityProfiles: typeof capabilityProfiles;
  readonly capabilityAgentGetHealthCapableTotal: number;
  readonly agentHealth: typeof agentHealth;
} => ({
  authRejects: { ...authRejects },
  sessionRejectedActiveTotal,
  sessionTakeoverDisconnectTotal,
  agentIdleTimeoutDisconnectTotal,
  sessionRegisterRateLimitedTotal,
  agentReadyLegacyPayloadTotal,
  agentReadyInvalidPartialPayloadTotal,
  inboundContractValidation: { ...inboundContractValidation },
  capabilityProfiles: { ...capabilityProfiles },
  capabilityAgentGetHealthCapableTotal,
  agentHealth: { ...agentHealth },
});

export const resetSocketAgentMetrics = (): void => {
  authRejects.missing_token = 0;
  authRejects.invalid_token = 0;
  authRejects.role_denied = 0;
  authRejects.blocked_account = 0;
  authRejects.account_validation_error = 0;
  sessionRejectedActiveTotal = 0;
  sessionTakeoverDisconnectTotal = 0;
  agentIdleTimeoutDisconnectTotal = 0;
  sessionRegisterRateLimitedTotal = 0;
  agentReadyLegacyPayloadTotal = 0;
  agentReadyInvalidPartialPayloadTotal = 0;
  inboundContractValidation.failedTotal = 0;
  inboundContractValidation.warnTotal = 0;
  capabilityProfiles.current = 0;
  capabilityProfiles.older = 0;
  capabilityProfiles.unknown = 0;
  capabilityAgentGetHealthCapableTotal = 0;
  agentHealth.responsesTotal = 0;
  agentHealth.errorsTotal = 0;
  agentHealth.lastSeenAtMs = 0;
  agentHealth.lastHealthy = 0;
  agentHealth.lastDegraded = 0;
  agentHealth.lastUptimeSeconds = 0;
  agentHealth.lastSqlQueueCurrentSize = 0;
  agentHealth.lastSqlQueueMaxSize = 0;
  agentHealth.lastActiveWorkers = 0;
  agentHealth.lastMaxWorkers = 0;
  agentHealth.lastSqlQueueRejectionsTotal = 0;
  agentHealth.lastSqlQueueTimeoutsTotal = 0;
  agentHealth.lastSqlQueueAvgWaitTimeMs = 0;
  agentHealth.lastQueryTotal = 0;
  agentHealth.lastQueryErrors = 0;
  agentHealth.lastQuerySuccessRate = 0;
  agentHealth.lastAvgLatencyMs = 0;
  agentHealth.lastP95LatencyMs = 0;
  agentHealth.lastP99LatencyMs = 0;
};
