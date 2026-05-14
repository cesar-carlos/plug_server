export interface AgentSocketDisconnectPrincipalEvent {
  readonly userId: string;
  readonly reason: "account_blocked";
}

interface AgentSocketControlHandler {
  disconnectPrincipal(input: AgentSocketDisconnectPrincipalEvent): Promise<void>;
}

type AgentSocketControlHandlerDisposer = () => void;

const handlers = new Set<AgentSocketControlHandler>();

export const registerAgentSocketControlHandler = (
  next: AgentSocketControlHandler,
): AgentSocketControlHandlerDisposer => {
  handlers.add(next);
  return () => {
    handlers.delete(next);
  };
};

export const disconnectAgentPrincipalSockets = async (
  event: AgentSocketDisconnectPrincipalEvent,
): Promise<void> => {
  await Promise.all([...handlers].map((handler) => handler.disconnectPrincipal(event)));
};
