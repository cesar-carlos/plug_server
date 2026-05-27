export type CustomSocketEventRoomRecipientCountStrategy =
  | { readonly kind: "exact_local"; readonly recipients: number }
  | {
      readonly kind: "local_only";
      readonly recipients: number;
      /** Local count is 0 but remote replicas may still have subscribers. */
      readonly allowEmitWithoutLocalSubscribers: boolean;
    }
  | { readonly kind: "local_exceeds_cap"; readonly recipients: number }
  | { readonly kind: "fetch_distributed" };

/**
 * Lightweight shape of a Socket.IO `RemoteSocket` for downstream consumers
 * that only need the principal id projection. Decoupled from the full
 * `RemoteSocket` type so this module stays free of `socket.io` dependency.
 */
export type RemoteSocketLike = { readonly data?: unknown };

export type ResolvedCustomSocketEventRoomRecipientCount<
  S extends RemoteSocketLike = RemoteSocketLike,
> = {
  readonly recipients: number;
  readonly recipientCountBestEffort: boolean;
  readonly recipientCountLocalOnly: boolean;
  /**
   * Sockets returned by the cluster-wide `fetchSockets()` call when the
   * count strategy required a distributed lookup. Set only on the path
   * where we actually paid the RPC: callers that need per-socket data
   * (principal ids, etc.) should reuse this array instead of issuing a
   * second `fetchSockets()` round-trip. Undefined for local-only paths.
   */
  readonly fetchedSockets?: ReadonlyArray<S>;
};

/**
 * Chooses how to count subscribers before a `client:custom.*` publish.
 *
 * With Redis adapter active, `fetchSockets()` is cluster-wide and expensive on the hot path.
 * When `maxRecipients` is unset (`0`), local room size is enough to proceed and the Redis
 * adapter still delivers to remote replicas on emit. When a cap is configured, distributed
 * counting (or a local lower bound above the cap) is required for safe shedding.
 */
export const resolveCustomSocketEventRoomRecipientCountStrategy = (input: {
  readonly redisAdapterActive: boolean;
  readonly localRecipients: number;
  readonly maxRecipients: number;
}): CustomSocketEventRoomRecipientCountStrategy => {
  if (!input.redisAdapterActive) {
    return { kind: "exact_local", recipients: input.localRecipients };
  }

  if (input.maxRecipients === 0) {
    return {
      kind: "local_only",
      recipients: input.localRecipients,
      allowEmitWithoutLocalSubscribers: input.localRecipients === 0,
    };
  }

  if (input.localRecipients > input.maxRecipients) {
    return { kind: "local_exceeds_cap", recipients: input.localRecipients };
  }

  return { kind: "fetch_distributed" };
};

export const toRoomRecipientCountFromStrategy = (
  strategy: Exclude<
    CustomSocketEventRoomRecipientCountStrategy,
    { readonly kind: "fetch_distributed" }
  >,
): ResolvedCustomSocketEventRoomRecipientCount => {
  switch (strategy.kind) {
    case "exact_local":
      return {
        recipients: strategy.recipients,
        recipientCountBestEffort: false,
        recipientCountLocalOnly: false,
      };
    case "local_only":
      return {
        recipients: strategy.recipients,
        recipientCountBestEffort: false,
        recipientCountLocalOnly: true,
      };
    case "local_exceeds_cap":
      return {
        recipients: strategy.recipients,
        recipientCountBestEffort: false,
        recipientCountLocalOnly: false,
      };
  }
};

export const shouldSkipCustomSocketEventZeroRecipientEarlyReturn = (
  count: Pick<
    ResolvedCustomSocketEventRoomRecipientCount,
    "recipientCountLocalOnly" | "recipients"
  >,
): boolean => count.recipientCountLocalOnly && count.recipients === 0;
