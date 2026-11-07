import { describe, expect, it, vi } from "vitest";
import { probeActionIoClock } from "../../../../../src/presentation/socket/hub/relay/action_io_clock_probe";
import { applyActionIoDeadline } from "../../../../../src/application/agent_commands/action_io_deadline";
import { bridgeSingleCommandSchema } from "../../../../../src/shared/validators/agent_command";
const command = bridgeSingleCommandSchema.parse({
  method: "agent.action.listAvailable",
  id: "catalog",
  params: {},
});
const extensions = { agentActions: { deadlineClock: 1 } };
const capabilities = { extensions };
describe("connection monotonic deadline", () => {
  it.each([NaN, Infinity, -Infinity, 0, -1])(
    "refuses invalid budget %s before probing",
    async (budget) => {
      const timeout = vi.fn(() => ({
        emitWithAck: async () => ({ version: 1, clock_id: "s", monotonic_ms: 1 }),
      }));
      await expect(
        probeActionIoClock(command, capabilities, { timeout }, () => budget, undefined, extensions),
      ).rejects.toMatchObject({ code: "ACTION_IO_REQUEST_EXPIRED" });
      expect(timeout).not.toHaveBeenCalled();
    },
  );
  it.each([-86400000, 0, 86400000])(
    "keeps the fixed budget despite wall clock offset %i and later queues",
    async (offset) => {
      let remaining = 28000;
      const emitWithAck = vi.fn(async () => {
        remaining -= 350;
        return { version: 1, clock_id: "session", monotonic_ms: 5000 };
      });
      const timeout = vi.fn(() => ({ emitWithAck }));
      const clock = await probeActionIoClock(
        command,
        capabilities,
        { timeout },
        () => remaining,
        undefined,
        extensions,
      );
      expect(timeout).toHaveBeenCalledWith(28000);
      expect(emitWithAck).toHaveBeenCalledWith("rpc:clock.probe", { version: 1 });
      expect(clock).toEqual({
        action_io_clock_id: "session",
        action_io_monotonic_deadline_ms: 32650,
      });
      // Hub wall-clock and subsequent queue duration cannot renew agent deadline.
      const payload = applyActionIoDeadline(command, command, 20000, 100000000 + offset, {
        ...clock,
      });
      expect(payload).toMatchObject({ meta: { ...clock, action_io_remaining_ms: 20000 } });
    },
  );
  it.each([{}, { agentActions: { deadlineClock: 2 } }])(
    "keeps legacy peers unchanged",
    async (legacy) => {
      const timeout = vi.fn();
      expect(
        await probeActionIoClock(
          command,
          { extensions: legacy },
          { timeout },
          () => 30000,
          undefined,
          extensions,
        ),
      ).toBeUndefined();
      expect(
        await probeActionIoClock(
          command,
          capabilities,
          { timeout },
          () => 30000,
          undefined,
          legacy,
        ),
      ).toBeUndefined();
      expect(timeout).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    {},
    { version: 1, clock_id: "", monotonic_ms: 1 },
    { version: 1, clock_id: "s", monotonic_ms: -1 },
    { version: 1, clock_id: "s", monotonic_ms: 1.5 },
    { version: 2, clock_id: "s", monotonic_ms: 1 },
    { version: 1, clock_id: "s".repeat(129), monotonic_ms: 1 },
    { version: 1, clock_id: "s", monotonic_ms: Number.MAX_SAFE_INTEGER },
    { version: 1, clock_id: "s", monotonic_ms: Infinity },
  ])("rejects malformed samples without legacy downgrade", async (sample) => {
    await expect(
      probeActionIoClock(
        command,
        capabilities,
        { timeout: () => ({ emitWithAck: async () => sample }) },
        () => 30000,
        undefined,
        extensions,
      ),
    ).rejects.toMatchObject({ code: "ACTION_IO_REQUEST_EXPIRED" });
  });
  it("rejects a probe which consumed the deadline", async () => {
    let remaining = 10;
    await expect(
      probeActionIoClock(
        command,
        capabilities,
        {
          timeout: () => ({
            emitWithAck: async () => {
              remaining = 0;
              return { version: 1, clock_id: "s", monotonic_ms: 50 };
            },
          }),
        },
        () => remaining,
        undefined,
        extensions,
      ),
    ).rejects.toMatchObject({ code: "ACTION_IO_REQUEST_EXPIRED" });
  });
  it("cancels an outstanding probe without dispatch or replay", async () => {
    const abort = new AbortController();
    const pending = probeActionIoClock(
      command,
      capabilities,
      { timeout: () => ({ emitWithAck: () => new Promise(() => {}) }) },
      () => 30000,
      abort.signal,
      extensions,
    );
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "ACTION_IO_REQUEST_EXPIRED" });
  });
  it("does not retry a failed probe", async () => {
    const emitWithAck = vi.fn(async () => {
      throw new Error("disconnected");
    });
    await expect(
      probeActionIoClock(
        command,
        capabilities,
        { timeout: () => ({ emitWithAck }) },
        () => 30000,
        undefined,
        extensions,
      ),
    ).rejects.toMatchObject({ code: "ACTION_IO_REQUEST_EXPIRED" });
    expect(emitWithAck).toHaveBeenCalledTimes(1);
  });
});
