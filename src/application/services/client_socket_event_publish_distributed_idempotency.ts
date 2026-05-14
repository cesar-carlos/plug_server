import type {
  ClientSocketEventPublishIdempotencyEntry,
  ClientSocketEventPublishIdempotencyResponse,
} from "./client_socket_event_idempotency_store";

export interface ClientSocketEventPublishDistributedIdempotencyStore {
  getEntry(
    clientId: string,
    idempotencyKey: string,
  ): Promise<ClientSocketEventPublishIdempotencyEntry | undefined>;
  setEntry(
    clientId: string,
    idempotencyKey: string,
    entry: {
      readonly fingerprint: string;
      readonly response: ClientSocketEventPublishIdempotencyResponse;
    },
  ): Promise<void>;
  acquireLock(clientId: string, idempotencyKey: string, ttlMs: number): Promise<string | undefined>;
  releaseLock(clientId: string, idempotencyKey: string, token: string): Promise<void>;
}

let store: ClientSocketEventPublishDistributedIdempotencyStore | undefined;

export const registerClientSocketEventPublishDistributedIdempotencyStore = (
  next: ClientSocketEventPublishDistributedIdempotencyStore | undefined,
): void => {
  store = next;
};

export const getClientSocketEventPublishDistributedIdempotencyStore = ():
  | ClientSocketEventPublishDistributedIdempotencyStore
  | undefined => store;
