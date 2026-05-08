export interface AgentSocketDisconnectPrincipalEvent {
  readonly userId: string;
  readonly reason: "account_blocked";
}

interface AgentSocketControlHandler {
  disconnectPrincipal(input: AgentSocketDisconnectPrincipalEvent): Promise<void>;
}

let handler: AgentSocketControlHandler | undefined;

export const registerAgentSocketControlHandler = (
  next: AgentSocketControlHandler | undefined,
): void => {
  handler = next;
};

export const disconnectAgentPrincipalSockets = async (
  event: AgentSocketDisconnectPrincipalEvent,
): Promise<void> => {
  await handler?.disconnectPrincipal(event);
};
