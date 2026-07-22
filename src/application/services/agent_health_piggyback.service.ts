import { HUB_TRANSPORT_EXTENSIONS } from "../../shared/constants/agent_transport_contract";
import { isHealthPiggybackNegotiated } from "../../shared/constants/transport_extension_negotiation";
import {
  noteAgentHealthPiggybackUsed,
  noteAgentHealthPiggybackSnapshot,
} from "../../shared/metrics/socket_agent.metrics";
import { isRecord } from "../../shared/utils/rpc_types";

interface AgentPiggybackFreshness {
  readonly capturedAtMs: number;
  readonly freshnessThresholdMs: number;
}

const freshnessByAgentId = new Map<string, AgentPiggybackFreshness>();

const readFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readHealthSnapshot = (rpcBody: unknown): Record<string, unknown> | null => {
  if (!isRecord(rpcBody) || !isRecord(rpcBody.meta)) {
    return null;
  }
  const snapshot = rpcBody.meta.health_snapshot ?? rpcBody.meta.healthSnapshot;
  return isRecord(snapshot) ? snapshot : null;
};

export const resolveNegotiatedHealthPiggybackFreshnessThresholdMs = (
  agentCapabilities: Record<string, unknown>,
): number | null => {
  if (!isHealthPiggybackNegotiated(agentCapabilities)) {
    return null;
  }

  const extensions = isRecord(agentCapabilities.extensions) ? agentCapabilities.extensions : null;
  const negotiated = extensions?.healthPiggyback ?? extensions?.health_piggyback;
  if (isRecord(negotiated)) {
    const fromNegotiation =
      readFiniteNumber(negotiated.freshnessThresholdMs) ??
      readFiniteNumber(negotiated.freshness_threshold_ms);
    if (fromNegotiation !== null && fromNegotiation > 0) {
      return fromNegotiation;
    }
  }

  const hubDefault = HUB_TRANSPORT_EXTENSIONS.healthPiggyback.freshnessThresholdMs;
  return hubDefault > 0 ? hubDefault : 5000;
};

const resolveFreshnessThresholdMs = (
  snapshot: Record<string, unknown>,
  agentCapabilities: Record<string, unknown> | null,
  negotiatedFreshnessThresholdMs: number | null,
): number => {
  const fromSnapshot =
    readFiniteNumber(snapshot.freshness_threshold_ms) ??
    readFiniteNumber(snapshot.freshnessThresholdMs);
  if (fromSnapshot !== null && fromSnapshot > 0) {
    return fromSnapshot;
  }

  if (negotiatedFreshnessThresholdMs !== null && negotiatedFreshnessThresholdMs > 0) {
    return negotiatedFreshnessThresholdMs;
  }

  if (agentCapabilities !== null) {
    const fromRegister = resolveNegotiatedHealthPiggybackFreshnessThresholdMs(agentCapabilities);
    if (fromRegister !== null) {
      return fromRegister;
    }
  }

  const hubDefault = HUB_TRANSPORT_EXTENSIONS.healthPiggyback.freshnessThresholdMs;
  return hubDefault > 0 ? hubDefault : 5000;
};

export const shouldSkipScheduledAgentHealthPoll = (
  agentId: string,
  nowMs = Date.now(),
): boolean => {
  const freshness = freshnessByAgentId.get(agentId);
  if (!freshness) {
    return false;
  }
  return nowMs - freshness.capturedAtMs <= freshness.freshnessThresholdMs;
};

export const maybeRecordAgentHealthPiggyback = (params: {
  readonly agentId: string;
  readonly agentCapabilities?: Record<string, unknown>;
  readonly negotiatedFreshnessThresholdMs?: number;
  readonly rpcBody: unknown;
  readonly nowMs?: number;
}): boolean => {
  const negotiatedFreshnessThresholdMs =
    params.negotiatedFreshnessThresholdMs ??
    (params.agentCapabilities !== undefined
      ? resolveNegotiatedHealthPiggybackFreshnessThresholdMs(params.agentCapabilities)
      : null);
  if (negotiatedFreshnessThresholdMs === null) {
    return false;
  }

  const snapshot = readHealthSnapshot(params.rpcBody);
  if (!snapshot) {
    return false;
  }

  const capturedAtMs =
    readFiniteNumber(snapshot.captured_at_ms) ?? readFiniteNumber(snapshot.capturedAtMs);
  if (capturedAtMs === null || capturedAtMs <= 0) {
    return false;
  }

  const nowMs = params.nowMs ?? Date.now();
  const freshnessThresholdMs = resolveFreshnessThresholdMs(
    snapshot,
    params.agentCapabilities ?? null,
    negotiatedFreshnessThresholdMs,
  );
  if (nowMs - capturedAtMs > freshnessThresholdMs) {
    return false;
  }

  freshnessByAgentId.set(params.agentId, {
    capturedAtMs,
    freshnessThresholdMs,
  });
  noteAgentHealthPiggybackSnapshot(snapshot);
  noteAgentHealthPiggybackUsed();
  return true;
};

export const clearAgentHealthPiggybackState = (agentId?: string): void => {
  if (agentId === undefined) {
    freshnessByAgentId.clear();
    return;
  }
  freshnessByAgentId.delete(agentId);
};
