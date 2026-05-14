import type { Socket } from "socket.io";

interface JoinableRoomSocket {
  readonly rooms?: ReadonlySet<string>;
  join(room: string | readonly string[]): Promise<void> | void;
}

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
  socket: JoinableRoomSocket | Pick<Socket, "join" | "rooms">,
  input: { readonly clientId: string; readonly agentId: string },
): Promise<void> => {
  const rooms = [
    buildConsumerClientAgentRoom(input),
    buildConsumerAgentProfileRoom(input.agentId),
  ].filter((room) => !socket.rooms?.has(room));
  if (rooms.length === 0) {
    return;
  }
  await socket.join(rooms);
};
