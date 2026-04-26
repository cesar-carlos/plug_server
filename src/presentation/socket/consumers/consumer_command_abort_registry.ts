const abortControllersBySocketId = new Map<string, Set<AbortController>>();

export const registerConsumerCommandAbortController = (
  socketId: string,
  controller: AbortController,
): (() => void) => {
  const existing = abortControllersBySocketId.get(socketId);
  if (existing) {
    existing.add(controller);
  } else {
    abortControllersBySocketId.set(socketId, new Set([controller]));
  }

  return () => {
    const controllers = abortControllersBySocketId.get(socketId);
    if (!controllers) {
      return;
    }
    controllers.delete(controller);
    if (controllers.size === 0) {
      abortControllersBySocketId.delete(socketId);
    }
  };
};

export const abortPendingConsumerCommands = (
  socketId: string,
  reason = "Consumer socket disconnected",
): number => {
  const controllers = abortControllersBySocketId.get(socketId);
  if (!controllers) {
    return 0;
  }
  abortControllersBySocketId.delete(socketId);
  for (const controller of controllers) {
    controller.abort(reason);
  }
  return controllers.size;
};

export const resetConsumerCommandAbortRegistry = (): void => {
  abortControllersBySocketId.clear();
};
