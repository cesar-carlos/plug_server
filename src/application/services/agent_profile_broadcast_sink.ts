export interface AgentProfileBroadcastEvent {
  readonly agentId: string;
  readonly profileVersion: number;
  readonly profileUpdatedAt: string | null;
  readonly source: string;
  readonly changedFields: readonly string[];
}

type AgentProfileBroadcastHandler = (event: AgentProfileBroadcastEvent) => Promise<void>;

type AgentProfileBroadcastHandlerDisposer = () => void;

const handlers = new Set<AgentProfileBroadcastHandler>();

export const registerAgentProfileBroadcastHandler = (
  next: AgentProfileBroadcastHandler,
): AgentProfileBroadcastHandlerDisposer => {
  handlers.add(next);
  return () => {
    handlers.delete(next);
  };
};

export const emitAgentProfileBroadcastEvent = async (
  event: AgentProfileBroadcastEvent,
): Promise<void> => {
  await Promise.all([...handlers].map((handler) => handler(event)));
};
