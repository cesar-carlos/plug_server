import type { Socket } from "socket.io";

type SocketWithSubscriptionOperationTail = Socket & {
  data: {
    customSocketEventSubscriptionOperationTail?: Promise<void>;
  };
};

/**
 * Serializes subscription mutations per socket. A Socket.IO client can emit
 * subscribe/unsubscribe frames back-to-back, while room joins/leaves may be
 * asynchronous under a distributed adapter. Keeping this tail on `socket.data`
 * avoids a process-global registry and lets the socket be garbage-collected
 * normally after disconnect.
 */
export const enqueueSocketSubscriptionOperation = (
  socket: Socket,
  operation: () => Promise<void>,
): Promise<void> => {
  const queuedSocket = socket as SocketWithSubscriptionOperationTail;
  const previous =
    queuedSocket.data.customSocketEventSubscriptionOperationTail ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.catch(() => undefined);
  queuedSocket.data.customSocketEventSubscriptionOperationTail = tail;

  return result.finally(() => {
    if (queuedSocket.data.customSocketEventSubscriptionOperationTail === tail) {
      delete queuedSocket.data.customSocketEventSubscriptionOperationTail;
    }
  });
};
