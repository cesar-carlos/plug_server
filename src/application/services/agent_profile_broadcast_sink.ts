export interface AgentProfileBroadcastEvent {
  readonly agentId: string;
  readonly profileVersion: number;
  readonly profileUpdatedAt: string | null;
  readonly source: string;
  readonly changedFields: readonly string[];
}

type AgentProfileBroadcastHandler = (event: AgentProfileBroadcastEvent) => Promise<void>;

let handler: AgentProfileBroadcastHandler | undefined;

export const registerAgentProfileBroadcastHandler = (
  next: AgentProfileBroadcastHandler | undefined,
): void => {
  handler = next;
};

export const emitAgentProfileBroadcastEvent = async (
  event: AgentProfileBroadcastEvent,
): Promise<void> => {
  await handler?.(event);
};
