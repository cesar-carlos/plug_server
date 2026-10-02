import { env } from "../../../../shared/config/env";
import { isPayloadFrameEnvelope } from "../../../../shared/utils/payload_frame";
import { agentRegistry } from "../registries/agent_registry";

export type AgentInboundGuardEvent =
  "rpc:response" | "rpc:chunk" | "rpc:complete" | "rpc:request_ack" | "rpc:batch_ack";

export type AgentInboundGuardClass = "ack" | "unary" | "stream";

export type AgentInboundAdmitResult =
  | { readonly admitted: true; readonly release: () => void }
  | {
      readonly admitted: false;
      readonly reason: string;
      readonly disconnect: boolean;
    };

const WINDOW_MS = 1_000;

const rejectedByEvent = new Map<string, number>();
const bytesRejectedByKind = { compressed: 0, decoded: 0 };
let violationDisconnectTotal = 0;
let pendingWork = 0;

type ClassBudget = {
  frames: number;
  compressedBytes: number;
  decodedBytes: number;
};

type SocketGuardState = {
  windowStartedAtMs: number;
  pendingWork: number;
  consecutiveViolations: number;
  byClass: Record<AgentInboundGuardClass, ClassBudget>;
};

const emptyClassBudget = (): ClassBudget => ({
  frames: 0,
  compressedBytes: 0,
  decodedBytes: 0,
});

const emptyClassBudgets = (): Record<AgentInboundGuardClass, ClassBudget> => ({
  ack: emptyClassBudget(),
  unary: emptyClassBudget(),
  stream: emptyClassBudget(),
});

const stateByKey = new Map<string, SocketGuardState>();
const budgetKeyBySocketId = new Map<string, string>();
const socketsByBudgetKey = new Map<string, Set<string>>();
const pendingWorkBySocketId = new Map<string, number>();

const socketBudgetKey = (socketId: string): string => `socket:${socketId}`;

const agentBudgetKey = (agentId: string): string => `agent:${agentId}`;

const resolveBudgetKey = (socketId: string): string => {
  const agentId = agentRegistry.getAgentIdBySocketId(socketId);
  if (agentId) {
    return agentBudgetKey(agentId);
  }
  return socketBudgetKey(socketId);
};

const trackSocketBudgetKey = (socketId: string, budgetKey: string): void => {
  const previous = budgetKeyBySocketId.get(socketId);
  if (previous === budgetKey) {
    return;
  }
  if (previous) {
    const previousSockets = socketsByBudgetKey.get(previous);
    previousSockets?.delete(socketId);
    if (previousSockets !== undefined && previousSockets.size === 0) {
      socketsByBudgetKey.delete(previous);
      if (previous.startsWith("socket:")) {
        stateByKey.delete(previous);
      }
    }
  }
  budgetKeyBySocketId.set(socketId, budgetKey);
  const sockets = socketsByBudgetKey.get(budgetKey) ?? new Set<string>();
  sockets.add(socketId);
  socketsByBudgetKey.set(budgetKey, sockets);
};

const classifyEvent = (event: AgentInboundGuardEvent): AgentInboundGuardClass => {
  if (event === "rpc:request_ack" || event === "rpc:batch_ack") {
    return "ack";
  }
  if (event === "rpc:chunk" || event === "rpc:complete") {
    return "stream";
  }
  return "unary";
};

const getOrCreateState = (budgetKey: string, nowMs: number): SocketGuardState => {
  const existing = stateByKey.get(budgetKey);
  if (!existing) {
    const created: SocketGuardState = {
      windowStartedAtMs: nowMs,
      pendingWork: 0,
      consecutiveViolations: 0,
      byClass: emptyClassBudgets(),
    };
    stateByKey.set(budgetKey, created);
    return created;
  }
  if (nowMs - existing.windowStartedAtMs >= WINDOW_MS) {
    existing.windowStartedAtMs = nowMs;
    existing.byClass = emptyClassBudgets();
  }
  return existing;
};

const noteRejected = (
  event: AgentInboundGuardEvent,
  reason: string,
  bytes?: { readonly kind: "compressed" | "decoded"; readonly amount: number },
): void => {
  const key = `${event}:${reason}`;
  rejectedByEvent.set(key, (rejectedByEvent.get(key) ?? 0) + 1);
  if (bytes && bytes.amount > 0) {
    bytesRejectedByKind[bytes.kind] += bytes.amount;
  }
};

const inspectDeclaredSizes = (
  rawPayload: unknown,
): { readonly compressedSize: number; readonly originalSize: number } | null => {
  if (!isPayloadFrameEnvelope(rawPayload)) {
    return null;
  }
  return {
    compressedSize: rawPayload.compressedSize,
    originalSize: rawPayload.originalSize,
  };
};

export const admitAgentInboundFrame = (input: {
  readonly socketId: string;
  readonly event: AgentInboundGuardEvent;
  readonly rawPayload: unknown;
}): AgentInboundAdmitResult => {
  const nowMs = Date.now();
  const budgetKey = resolveBudgetKey(input.socketId);
  trackSocketBudgetKey(input.socketId, budgetKey);
  const state = getOrCreateState(budgetKey, nowMs);
  const sizes = inspectDeclaredSizes(input.rawPayload);
  const mode = env.socketAgentInboundGuardMode;
  const guardClass = classifyEvent(input.event);
  const classBudget = state.byClass[guardClass];
  const maxFrames =
    guardClass === "ack"
      ? env.socketAgentInboundMaxAckFramesPerWindow
      : env.socketAgentInboundMaxFramesPerWindow;
  const maxCompressed = env.socketAgentInboundMaxCompressedBytesPerWindow;
  const maxDecoded = env.socketAgentInboundMaxDecodedBytesPerWindow;
  const maxPending = env.socketAgentInboundMaxPendingWork;
  const violationsBeforeDisconnect = env.socketAgentInboundViolationsBeforeDisconnect;

  let reason: string | null = null;
  let rejectedBytes:
    { readonly kind: "compressed" | "decoded"; readonly amount: number } | undefined;
  if (sizes === null) {
    reason = "invalid_frame";
  } else if (maxPending > 0 && state.pendingWork >= maxPending) {
    reason = "pending_work";
  } else if (maxFrames > 0 && classBudget.frames >= maxFrames) {
    reason = "frames";
  } else if (
    maxCompressed > 0 &&
    classBudget.compressedBytes + sizes.compressedSize > maxCompressed
  ) {
    reason = "compressed_bytes";
    rejectedBytes = { kind: "compressed", amount: sizes.compressedSize };
  } else if (maxDecoded > 0 && classBudget.decodedBytes + sizes.originalSize > maxDecoded) {
    reason = "decoded_bytes";
    rejectedBytes = { kind: "decoded", amount: sizes.originalSize };
  }

  if (reason !== null) {
    noteRejected(input.event, reason, rejectedBytes);
    state.consecutiveViolations += 1;
    const disconnect =
      mode === "enforce" &&
      violationsBeforeDisconnect > 0 &&
      state.consecutiveViolations >= violationsBeforeDisconnect;
    if (disconnect) {
      violationDisconnectTotal += 1;
    }
    if (mode === "enforce" || sizes === null) {
      if (mode === "observe" && sizes === null) {
        return { admitted: true, release: (): void => undefined };
      }
      if (mode === "enforce") {
        return { admitted: false, reason, disconnect };
      }
    }
  } else {
    state.consecutiveViolations = 0;
  }

  if (sizes !== null && (reason === null || mode === "observe")) {
    classBudget.frames += 1;
    classBudget.compressedBytes += sizes.compressedSize;
    classBudget.decodedBytes += sizes.originalSize;
  }
  state.pendingWork += 1;
  pendingWork += 1;
  pendingWorkBySocketId.set(input.socketId, (pendingWorkBySocketId.get(input.socketId) ?? 0) + 1);
  let released = false;
  return {
    admitted: true,
    release: (): void => {
      if (released) {
        return;
      }
      released = true;
      const tracked = pendingWorkBySocketId.get(input.socketId);
      if (tracked === undefined) {
        // Disconnect cleanup already released this socket's pending budget.
        return;
      }
      state.pendingWork = Math.max(0, state.pendingWork - 1);
      pendingWork = Math.max(0, pendingWork - 1);
      const remaining = tracked - 1;
      if (remaining <= 0) {
        pendingWorkBySocketId.delete(input.socketId);
        return;
      }
      pendingWorkBySocketId.set(input.socketId, remaining);
    },
  };
};

export const cleanupAgentInboundIngressSocket = (socketId: string): void => {
  const budgetKey = budgetKeyBySocketId.get(socketId) ?? socketBudgetKey(socketId);
  const socketPending = pendingWorkBySocketId.get(socketId) ?? 0;
  const state = stateByKey.get(budgetKey);
  if (state && socketPending > 0) {
    state.pendingWork = Math.max(0, state.pendingWork - socketPending);
    pendingWork = Math.max(0, pendingWork - socketPending);
  }
  pendingWorkBySocketId.delete(socketId);
  budgetKeyBySocketId.delete(socketId);
  const sockets = socketsByBudgetKey.get(budgetKey);
  sockets?.delete(socketId);
  stateByKey.delete(socketBudgetKey(socketId));
  if (sockets === undefined || sockets.size === 0) {
    socketsByBudgetKey.delete(budgetKey);
    stateByKey.delete(budgetKey);
  }
};

export const getAgentInboundIngressMetricsSnapshot = (): {
  readonly rejectedByEvent: Readonly<Record<string, number>>;
  readonly bytesRejectedCompressed: number;
  readonly bytesRejectedDecoded: number;
  readonly violationDisconnectTotal: number;
  readonly pendingWork: number;
} => ({
  rejectedByEvent: Object.fromEntries(rejectedByEvent.entries()),
  bytesRejectedCompressed: bytesRejectedByKind.compressed,
  bytesRejectedDecoded: bytesRejectedByKind.decoded,
  violationDisconnectTotal,
  pendingWork,
});

export const resetAgentInboundIngressForTests = (): void => {
  stateByKey.clear();
  budgetKeyBySocketId.clear();
  socketsByBudgetKey.clear();
  pendingWorkBySocketId.clear();
  rejectedByEvent.clear();
  bytesRejectedByKind.compressed = 0;
  bytesRejectedByKind.decoded = 0;
  violationDisconnectTotal = 0;
  pendingWork = 0;
};
