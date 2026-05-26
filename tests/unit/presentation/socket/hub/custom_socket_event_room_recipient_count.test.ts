import { describe, expect, it } from "vitest";

import {
  resolveCustomSocketEventRoomRecipientCountStrategy,
  shouldSkipCustomSocketEventZeroRecipientEarlyReturn,
  toRoomRecipientCountFromStrategy,
} from "../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_room_recipient_count";

describe("resolveCustomSocketEventRoomRecipientCountStrategy", () => {
  it("should use exact local count when the Redis adapter is inactive", () => {
    expect(
      resolveCustomSocketEventRoomRecipientCountStrategy({
        redisAdapterActive: false,
        localRecipients: 3,
        maxRecipients: 0,
      }),
    ).toEqual({ kind: "exact_local", recipients: 3 });
  });

  it("should skip fetchSockets when Redis is active and maxRecipients is unset", () => {
    expect(
      resolveCustomSocketEventRoomRecipientCountStrategy({
        redisAdapterActive: true,
        localRecipients: 2,
        maxRecipients: 0,
      }),
    ).toEqual({
      kind: "local_only",
      recipients: 2,
      allowEmitWithoutLocalSubscribers: false,
    });

    expect(
      resolveCustomSocketEventRoomRecipientCountStrategy({
        redisAdapterActive: true,
        localRecipients: 0,
        maxRecipients: 0,
      }),
    ).toEqual({
      kind: "local_only",
      recipients: 0,
      allowEmitWithoutLocalSubscribers: true,
    });
  });

  it("should reject via local lower bound when local recipients already exceed the cap", () => {
    expect(
      resolveCustomSocketEventRoomRecipientCountStrategy({
        redisAdapterActive: true,
        localRecipients: 300,
        maxRecipients: 256,
      }),
    ).toEqual({ kind: "local_exceeds_cap", recipients: 300 });
  });

  it("should fetch distributed count when a cap is configured and local count is within it", () => {
    expect(
      resolveCustomSocketEventRoomRecipientCountStrategy({
        redisAdapterActive: true,
        localRecipients: 10,
        maxRecipients: 256,
      }),
    ).toEqual({ kind: "fetch_distributed" });
  });
});

describe("toRoomRecipientCountFromStrategy", () => {
  it("should mark local-only counts without best-effort degradation", () => {
    expect(
      toRoomRecipientCountFromStrategy({
        kind: "local_only",
        recipients: 0,
        allowEmitWithoutLocalSubscribers: true,
      }),
    ).toEqual({
      recipients: 0,
      recipientCountBestEffort: false,
      recipientCountLocalOnly: true,
    });
  });
});

describe("shouldSkipCustomSocketEventZeroRecipientEarlyReturn", () => {
  it("should allow emit when local-only count is zero but remote subscribers may exist", () => {
    expect(
      shouldSkipCustomSocketEventZeroRecipientEarlyReturn({
        recipients: 0,
        recipientCountLocalOnly: true,
      }),
    ).toBe(true);
  });

  it("should keep the zero-recipient early return for verified exact counts", () => {
    expect(
      shouldSkipCustomSocketEventZeroRecipientEarlyReturn({
        recipients: 0,
        recipientCountLocalOnly: false,
      }),
    ).toBe(false);
  });
});
