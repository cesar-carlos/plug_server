const subscriptionsBySocketId = new Map<string, Set<string>>();

export const addCustomSocketEventSubscription = (socketId: string, eventName: string): boolean => {
  const existing = subscriptionsBySocketId.get(socketId);
  if (existing) {
    const before = existing.size;
    existing.add(eventName);
    return existing.size !== before;
  }
  subscriptionsBySocketId.set(socketId, new Set([eventName]));
  return true;
};

export const removeCustomSocketEventSubscription = (
  socketId: string,
  eventName: string,
): boolean => {
  const existing = subscriptionsBySocketId.get(socketId);
  if (!existing) {
    return false;
  }
  const removed = existing.delete(eventName);
  if (existing.size === 0) {
    subscriptionsBySocketId.delete(socketId);
  }
  return removed;
};

export const removeCustomSocketEventSubscriptionsBySocketId = (socketId: string): number => {
  const existing = subscriptionsBySocketId.get(socketId);
  if (!existing) {
    return 0;
  }
  const count = existing.size;
  subscriptionsBySocketId.delete(socketId);
  return count;
};

export const hasCustomSocketEventSubscription = (socketId: string, eventName: string): boolean =>
  subscriptionsBySocketId.get(socketId)?.has(eventName) ?? false;

export const countCustomSocketEventSubscriptionsBySocketId = (socketId: string): number =>
  subscriptionsBySocketId.get(socketId)?.size ?? 0;

export const countCustomSocketEventSubscriptions = (): number => {
  let total = 0;
  for (const subscriptions of subscriptionsBySocketId.values()) {
    total += subscriptions.size;
  }
  return total;
};

export const resetCustomSocketEventSubscriptions = (): void => {
  subscriptionsBySocketId.clear();
};
