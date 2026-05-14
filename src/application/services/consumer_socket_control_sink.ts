export interface ConsumerSocketDisconnectPrincipalEvent {
  readonly principalType: "user" | "client";
  readonly principalId: string;
  readonly reason: "account_blocked";
}

export interface ConsumerSocketRevokeClientAccessEvent {
  readonly clientId: string;
  readonly agentId: string;
  readonly reason: "client_access_revoked";
}

/** After DB grants client→agent access: join live `/consumers` sockets into the per-pair room. */
export interface ConsumerSocketGrantClientAccessEvent {
  readonly clientId: string;
  readonly agentId: string;
}

interface ConsumerSocketControlHandler {
  disconnectPrincipal(input: ConsumerSocketDisconnectPrincipalEvent): Promise<void>;
  revokeClientAccess(input: ConsumerSocketRevokeClientAccessEvent): Promise<void>;
  grantClientAccess(input: ConsumerSocketGrantClientAccessEvent): Promise<void>;
}

type ConsumerSocketControlHandlerDisposer = () => void;

const handlers = new Set<ConsumerSocketControlHandler>();

export const registerConsumerSocketControlHandler = (
  next: ConsumerSocketControlHandler,
): ConsumerSocketControlHandlerDisposer => {
  handlers.add(next);
  return () => {
    handlers.delete(next);
  };
};

export const disconnectConsumerPrincipalSockets = async (
  event: ConsumerSocketDisconnectPrincipalEvent,
): Promise<void> => {
  await Promise.all([...handlers].map((handler) => handler.disconnectPrincipal(event)));
};

export const revokeConsumerClientAccessSockets = async (
  event: ConsumerSocketRevokeClientAccessEvent,
): Promise<void> => {
  await Promise.all([...handlers].map((handler) => handler.revokeClientAccess(event)));
};

export const grantConsumerClientAccessRooms = async (
  event: ConsumerSocketGrantClientAccessEvent,
): Promise<void> => {
  await Promise.all([...handlers].map((handler) => handler.grantClientAccess(event)));
};
