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

interface ConsumerSocketControlHandler {
  disconnectPrincipal(input: ConsumerSocketDisconnectPrincipalEvent): Promise<void>;
  revokeClientAccess(input: ConsumerSocketRevokeClientAccessEvent): Promise<void>;
}

let handler: ConsumerSocketControlHandler | undefined;

export const registerConsumerSocketControlHandler = (
  next: ConsumerSocketControlHandler | undefined,
): void => {
  handler = next;
};

export const disconnectConsumerPrincipalSockets = async (
  event: ConsumerSocketDisconnectPrincipalEvent,
): Promise<void> => {
  await handler?.disconnectPrincipal(event);
};

export const revokeConsumerClientAccessSockets = async (
  event: ConsumerSocketRevokeClientAccessEvent,
): Promise<void> => {
  await handler?.revokeClientAccess(event);
};
