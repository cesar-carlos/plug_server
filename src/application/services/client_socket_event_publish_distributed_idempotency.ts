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
  /**
   * Extend the TTL of an existing lock if (and only if) the caller still owns
   * it (matching `token`). Returns `true` when the TTL was successfully
   * extended; `false` when the lock has expired or was acquired by someone
   * else. Atomic compare-and-pexpire via Lua to avoid the classic CHECK/SET
   * race window.
   */
  extendLock(
    clientId: string,
    idempotencyKey: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean>;
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
