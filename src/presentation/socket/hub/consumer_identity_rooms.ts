import type { Socket } from "socket.io";

export const buildConsumerPrincipalRoom = (input: {
  readonly principalType: "client" | "user";
  readonly principalId: string;
}): string => `consumer:principal:${input.principalType}:${input.principalId}`;

export const buildConsumerClientRoom = (clientId: string): string => `client:${clientId}`;

export const buildConsumerClientAgentRoom = (input: {
  readonly clientId: string;
  readonly agentId: string;
}): string => `consumer:client-agent:${input.clientId}:${input.agentId}`;

export const buildConsumerAgentProfileRoom = (agentId: string): string =>
  `consumer:agent-profile:${agentId}`;

export const joinConsumerClientAgentRoom = async (
  socket: Pick<Socket, "join">,
  input: { readonly clientId: string; readonly agentId: string },
): Promise<void> => {
  await socket.join([
    buildConsumerClientAgentRoom(input),
    buildConsumerAgentProfileRoom(input.agentId),
  ]);
};
