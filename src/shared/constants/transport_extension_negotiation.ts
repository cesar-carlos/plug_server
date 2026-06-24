import { HUB_TRANSPORT_EXTENSIONS } from "./agent_transport_contract";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readAgentExtensions = (
  capabilities: Record<string, unknown>,
): Record<string, unknown> | null => {
  const extensions = capabilities.extensions;
  return isRecord(extensions) ? extensions : null;
};

export const isClientRequestIdEchoNegotiated = (
  agentCapabilities: Record<string, unknown>,
): boolean => {
  const extensions = readAgentExtensions(agentCapabilities);
  return extensions?.clientRequestIdEcho === HUB_TRANSPORT_EXTENSIONS.clientRequestIdEcho;
};

export const isAgentPhaseTimingsNegotiated = (
  agentCapabilities: Record<string, unknown>,
): boolean => {
  const extensions = readAgentExtensions(agentCapabilities);
  return extensions?.agentPhaseTimings === HUB_TRANSPORT_EXTENSIONS.agentPhaseTimings;
};

export const isHealthPiggybackNegotiated = (
  agentCapabilities: Record<string, unknown>,
): boolean => {
  const extensions = readAgentExtensions(agentCapabilities);
  const agentRaw = extensions?.healthPiggyback;
  const hubRaw = HUB_TRANSPORT_EXTENSIONS.healthPiggyback;
  return isRecord(agentRaw) && isRecord(hubRaw);
};

const readParallelBatchDispatchBlock = (
  extensions: Record<string, unknown> | null,
): Record<string, unknown> | null => {
  const raw = extensions?.parallelBatchDispatch;
  return isRecord(raw) ? raw : null;
};

/**
 * True when hub and agent both advertise `parallelBatchDispatch.enabled`.
 * The agent applies full intersection (maxConcurrency, flags) in ProtocolNegotiator.
 */
export const isParallelBatchDispatchNegotiated = (
  agentCapabilities: Record<string, unknown>,
): boolean => {
  const hubBlock = HUB_TRANSPORT_EXTENSIONS.parallelBatchDispatch;
  if (!hubBlock.enabled) {
    return false;
  }
  const agentBlock = readParallelBatchDispatchBlock(readAgentExtensions(agentCapabilities));
  return agentBlock?.enabled === true;
};
