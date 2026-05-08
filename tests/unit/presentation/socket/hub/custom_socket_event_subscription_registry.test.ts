import { beforeEach, describe, expect, it } from "vitest";

import {
  addCustomSocketEventSubscription,
  countCustomSocketEventSubscriptions,
  countCustomSocketEventSubscriptionsBySocketId,
  hasCustomSocketEventSubscription,
  removeCustomSocketEventSubscription,
  removeCustomSocketEventSubscriptionsBySocketId,
  resetCustomSocketEventSubscriptions,
} from "../../../../../src/presentation/socket/hub/custom_socket_event_subscription_registry";

describe("custom_socket_event_subscription_registry", () => {
  beforeEach(() => {
    resetCustomSocketEventSubscriptions();
  });

  it("should track idempotent subscriptions and cleanup by socket", () => {
    expect(addCustomSocketEventSubscription("socket-1", "client:custom.a")).toBe(true);
    expect(addCustomSocketEventSubscription("socket-1", "client:custom.a")).toBe(false);
    expect(addCustomSocketEventSubscription("socket-1", "client:custom.b")).toBe(true);
    expect(countCustomSocketEventSubscriptions()).toBe(2);
    expect(countCustomSocketEventSubscriptionsBySocketId("socket-1")).toBe(2);
    expect(hasCustomSocketEventSubscription("socket-1", "client:custom.a")).toBe(true);
    expect(hasCustomSocketEventSubscription("socket-1", "client:custom.missing")).toBe(false);

    expect(removeCustomSocketEventSubscription("socket-1", "client:custom.a")).toBe(true);
    expect(countCustomSocketEventSubscriptions()).toBe(1);

    expect(removeCustomSocketEventSubscriptionsBySocketId("socket-1")).toBe(1);
    expect(countCustomSocketEventSubscriptions()).toBe(0);
  });
});
