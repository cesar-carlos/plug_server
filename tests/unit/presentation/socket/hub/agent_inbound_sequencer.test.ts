import { afterEach, describe, expect, it } from "vitest";

import {
  admitAgentInboundFrameSeq,
  cleanupAgentInboundSequencerSocket,
  completeAgentInboundCommitTurn,
  getAgentInboundSequencerMetricsSnapshot,
  resetAgentInboundSequencerForTests,
  getAgentInboundSequencerTrackedSocketCount,
  waitAgentInboundCommitTurn,
} from "../../../../../src/presentation/socket/hub/relay/agent_inbound_sequencer";

describe("agent_inbound_sequencer", () => {
  afterEach(() => {
    resetAgentInboundSequencerForTests();
  });

  it("does not retain disconnected identities across 20000 session cycles", async () => {
    for (let index = 0; index < 20_000; index += 1) {
      const socketId = `socket-${index}`;
      const ticket = admitAgentInboundFrameSeq(socketId);
      cleanupAgentInboundSequencerSocket(socketId);
      await expect(waitAgentInboundCommitTurn(ticket)).resolves.toBe("stale");
    }
    expect(getAgentInboundSequencerTrackedSocketCount()).toBe(0);
    expect(getAgentInboundSequencerMetricsSnapshot().pendingJobs).toBe(0);
  });

  it("rejects old tickets after socket-id reuse, idle pruning and resets", async () => {
    const old = admitAgentInboundFrameSeq("reused");
    completeAgentInboundCommitTurn(old);
    const live = admitAgentInboundFrameSeq("reused");
    await expect(waitAgentInboundCommitTurn(old)).resolves.toBe("stale");
    completeAgentInboundCommitTurn(old);
    await expect(waitAgentInboundCommitTurn(live)).resolves.toBe("live");
    const waiter = admitAgentInboundFrameSeq("reused");
    const waiting = waitAgentInboundCommitTurn(waiter);
    resetAgentInboundSequencerForTests();
    await expect(waiting).resolves.toBe("stale");
    const afterReset = admitAgentInboundFrameSeq("reused");
    await expect(waitAgentInboundCommitTurn(live)).resolves.toBe("stale");
    await expect(waitAgentInboundCommitTurn(afterReset)).resolves.toBe("live");
  });

  it("grants commit turns in admit order even when later work finishes first", async () => {
    const first = admitAgentInboundFrameSeq("socket-a");
    const second = admitAgentInboundFrameSeq("socket-a");
    const order: number[] = [];

    const secondTurn = waitAgentInboundCommitTurn(second).then(async (turn) => {
      order.push(2);
      expect(turn).toBe("live");
      completeAgentInboundCommitTurn(second);
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);

    const firstTurn = await waitAgentInboundCommitTurn(first);
    expect(firstTurn).toBe("live");
    order.push(1);
    completeAgentInboundCommitTurn(first);
    await secondTurn;
    expect(order).toEqual([1, 2]);
    expect(getAgentInboundSequencerMetricsSnapshot().outOfOrderPreventedTotal).toBe(1);
  });

  it("does not block a later frame when an earlier decode is skipped", async () => {
    const first = admitAgentInboundFrameSeq("socket-a");
    const second = admitAgentInboundFrameSeq("socket-a");
    const firstTurn = await waitAgentInboundCommitTurn(first);
    expect(firstTurn).toBe("live");
    completeAgentInboundCommitTurn(first);
    const secondTurn = await waitAgentInboundCommitTurn(second);
    expect(secondTurn).toBe("live");
    completeAgentInboundCommitTurn(second);
  });

  it("invalidates pending turns after disconnect cleanup", async () => {
    const first = admitAgentInboundFrameSeq("socket-a");
    const second = admitAgentInboundFrameSeq("socket-a");
    const secondTurn = waitAgentInboundCommitTurn(second);
    cleanupAgentInboundSequencerSocket("socket-a");
    await expect(secondTurn).resolves.toBe("stale");
    await expect(waitAgentInboundCommitTurn(first)).resolves.toBe("stale");
  });
});
