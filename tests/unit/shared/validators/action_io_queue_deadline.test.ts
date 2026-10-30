import { describe, expect, it } from "vitest";
import { actionIoQueueSignal } from "../../../../src/application/agent_commands/action_io_deadline";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";
const command = bridgeSingleCommandSchema.parse({
  method: "agent.action.findExecution",
  id: "i",
  params: { action_id: "a", idempotency_key: "k" },
});
describe("I/O queue deadline signal", () => {
  it("rejects an expired admission immediately", () => {
    expect(actionIoQueueSignal(command, 10, performance.now() - 100)?.aborted).toBe(true);
  });
  it("aborts a waiting admission when its budget expires", async () => {
    const signal = actionIoQueueSignal(command, 10, performance.now());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal?.aborted).toBe(true);
  });
  it("preserves caller cancellation and legacy signal identity", () => {
    const caller = new AbortController();
    const combined = actionIoQueueSignal(command, 30000, performance.now(), caller.signal);
    caller.abort();
    expect(combined?.aborted).toBe(true);
    const legacy = bridgeSingleCommandSchema.parse({ method: "agent.getHealth", id: "h" });
    expect(actionIoQueueSignal(legacy, 10, 0, caller.signal)).toBe(caller.signal);
  });
});
