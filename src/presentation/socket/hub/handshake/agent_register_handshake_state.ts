import type { AgentHubSocket } from "../handlers/_shared";

export type AgentRegisterHandshakePhase =
  "unregistered" | "registering" | "registered" | "disconnected";

export type AgentRegisterHandshakeDecision =
  | { readonly action: "proceed" }
  | { readonly action: "coalesce"; readonly inflight: Promise<void> }
  | { readonly action: "idempotent_replay" }
  | { readonly action: "reject"; readonly message: string };

interface HandshakeRecord {
  phase: AgentRegisterHandshakePhase;
  agentId?: string | undefined;
  frameRequestId?: string | null | undefined;
  capabilitiesKey?: string | undefined;
  inflight?: Promise<void> | undefined;
  resolveInflight?: (() => void) | undefined;
}

const stateBySocket = new WeakMap<AgentHubSocket, HandshakeRecord>();

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
};

export const agentRegisterCapabilitiesKey = (capabilities: unknown): string =>
  stableStringify(capabilities);

const getRecord = (socket: AgentHubSocket): HandshakeRecord => {
  const existing = stateBySocket.get(socket);
  if (existing) {
    return existing;
  }
  const created: HandshakeRecord = { phase: "unregistered" };
  stateBySocket.set(socket, created);
  return created;
};

export const evaluateAgentRegisterHandshake = (input: {
  readonly socket: AgentHubSocket;
  readonly agentId: string;
  readonly frameRequestId: string | null;
  readonly capabilitiesKey: string;
}): AgentRegisterHandshakeDecision => {
  const record = getRecord(input.socket);
  if (record.phase === "disconnected") {
    return {
      action: "reject",
      message: "agent:register ignored because the socket is disconnected",
    };
  }
  if (record.phase === "registering") {
    if (record.agentId === input.agentId && record.frameRequestId === input.frameRequestId) {
      if (record.inflight) {
        return { action: "coalesce", inflight: record.inflight };
      }
      return { action: "proceed" };
    }
    return {
      action: "reject",
      message: "agent:register is already in progress for a different identity on this socket",
    };
  }
  if (record.phase === "registered") {
    if (record.agentId === input.agentId && record.capabilitiesKey === input.capabilitiesKey) {
      return { action: "idempotent_replay" };
    }
    if (record.agentId === input.agentId) {
      return {
        action: "reject",
        message: "agent:register cannot change capabilities for an already registered socket",
      };
    }
    return {
      action: "reject",
      message: "agent:register cannot change agentId for an already registered socket",
    };
  }
  record.phase = "registering";
  record.agentId = input.agentId;
  record.frameRequestId = input.frameRequestId;
  record.capabilitiesKey = input.capabilitiesKey;
  let resolveInflight!: () => void;
  record.inflight = new Promise<void>((resolve) => {
    resolveInflight = resolve;
  });
  record.resolveInflight = resolveInflight;
  return { action: "proceed" };
};

export const resolveAgentRegisterInflight = (socket: AgentHubSocket): void => {
  const record = getRecord(socket);
  record.resolveInflight?.();
  record.resolveInflight = undefined;
  record.inflight = undefined;
};

export const completeAgentRegisterSuccess = (socket: AgentHubSocket, agentId: string): void => {
  const record = getRecord(socket);
  if (record.phase === "disconnected") {
    return;
  }
  record.phase = "registered";
  record.agentId = agentId;
};

export const completeAgentRegisterFailure = (socket: AgentHubSocket): void => {
  const record = getRecord(socket);
  if (record.phase === "disconnected" || record.phase === "registered") {
    return;
  }
  record.phase = "unregistered";
  record.agentId = undefined;
  record.frameRequestId = undefined;
  record.capabilitiesKey = undefined;
};

export const isAgentRegisterSocketRegistered = (socket: AgentHubSocket): boolean =>
  getRecord(socket).phase === "registered";

export const isAgentRegisterSocketDisconnected = (socket: AgentHubSocket): boolean =>
  getRecord(socket).phase === "disconnected";

export const markAgentRegisterSocketDisconnected = (socket: AgentHubSocket): void => {
  const record = getRecord(socket);
  record.phase = "disconnected";
  record.resolveInflight?.();
  record.resolveInflight = undefined;
  record.inflight = undefined;
};
