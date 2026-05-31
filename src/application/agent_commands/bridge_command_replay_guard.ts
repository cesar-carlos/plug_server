import type { BridgeCommand } from "../../shared/validators/agent_command";

const bridgeCommandReplayWindowMs = 120_000;
const completedReplayExpirations = new Map<string, number>();

type ReplayableJsonRpcId = string | number;

export interface BridgeCommandReplayId {
  readonly id: ReplayableJsonRpcId;
  readonly idType: "number" | "string";
  readonly requestId: string;
}

export interface BridgeCommandReplayDetected {
  readonly replayId: BridgeCommandReplayId;
  readonly response: Record<string, unknown>;
}

export const bridgeCommandReplayErrorCode = -32014;
export const bridgeCommandReplayReason = "replay_detected";
export const bridgeCommandReplayTtlMs = bridgeCommandReplayWindowMs;

const pruneExpiredReplayEntries = (nowMs: number): void => {
  for (const [key, expiresAtMs] of completedReplayExpirations.entries()) {
    if (expiresAtMs <= nowMs) {
      completedReplayExpirations.delete(key);
    }
  }
};

const replayKeyFor = (agentId: string, replayId: BridgeCommandReplayId): string =>
  `${agentId}\u0000${replayId.idType}\u0000${String(replayId.id)}`;

export const getSingleBridgeCommandReplayId = (
  command: BridgeCommand,
): BridgeCommandReplayId | null => {
  if (Array.isArray(command)) {
    return null;
  }

  const id = command.id;
  if (typeof id === "string" && id !== "") {
    return {
      id,
      idType: "string",
      requestId: id,
    };
  }

  if (typeof id === "number" && Number.isFinite(id)) {
    return {
      id,
      idType: "number",
      requestId: String(id),
    };
  }

  return null;
};

export const buildBridgeCommandReplayDetectedResponse = (
  replayId: BridgeCommandReplayId,
): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id: replayId.id,
  error: {
    code: bridgeCommandReplayErrorCode,
    message: "Replay detected",
    data: {
      reason: bridgeCommandReplayReason,
      category: "conflict",
      retryable: false,
      replay_window_ms: bridgeCommandReplayWindowMs,
      technical_message: "Duplicate JSON-RPC id rejected within the bridge replay window.",
      timestamp: new Date().toISOString(),
    },
  },
});

export const getCompletedBridgeCommandReplay = (input: {
  readonly agentId: string;
  readonly command: BridgeCommand;
  readonly nowMs?: number;
}): BridgeCommandReplayDetected | null => {
  const replayId = getSingleBridgeCommandReplayId(input.command);
  if (!replayId) {
    return null;
  }

  const nowMs = input.nowMs ?? Date.now();
  pruneExpiredReplayEntries(nowMs);
  const key = replayKeyFor(input.agentId, replayId);
  const expiresAtMs = completedReplayExpirations.get(key);
  if (expiresAtMs === undefined || expiresAtMs <= nowMs) {
    return null;
  }

  return {
    replayId,
    response: buildBridgeCommandReplayDetectedResponse(replayId),
  };
};

export const rememberCompletedBridgeCommand = (input: {
  readonly agentId: string;
  readonly command: BridgeCommand;
  readonly nowMs?: number;
}): void => {
  const replayId = getSingleBridgeCommandReplayId(input.command);
  if (!replayId) {
    return;
  }

  const nowMs = input.nowMs ?? Date.now();
  pruneExpiredReplayEntries(nowMs);
  completedReplayExpirations.set(
    replayKeyFor(input.agentId, replayId),
    nowMs + bridgeCommandReplayWindowMs,
  );
};

export const resetBridgeCommandReplayGuard = (): void => {
  completedReplayExpirations.clear();
};

export const resetBridgeCommandReplayGuardForTests = resetBridgeCommandReplayGuard;
