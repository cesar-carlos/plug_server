import { describe, expect, it } from "vitest";
import {
  remainingActionIoWaitMs,
  applyActionIoDeadline,
  limitActionIoReadWait,
  assertActionIoDeadline,
} from "../../../../src/application/agent_commands/action_io_deadline";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";
const command = bridgeSingleCommandSchema.parse({
  method: "agent.action.findExecution",
  id: "i",
  params: { action_id: "a", idempotency_key: "k" },
});
describe("I/O dispatch deadline", () => {
  it("charges preparation time and rejects dispatch at expiry", () => {
    expect(remainingActionIoWaitMs(command, 30000, 100, 5100)).toBe(25000);
    expect(remainingActionIoWaitMs(command, 10000, 100, 5100)).toBe(5000);
    expect(() => assertActionIoDeadline(command, 30000, 100, 30100)).toThrow(/expired/);
    expect(remainingActionIoWaitMs(command, 30000, 100, 40100)).toBe(0);
  });
  it("does not alter unrelated legacy timeouts", () => {
    const legacy = bridgeSingleCommandSchema.parse({ method: "agent.getHealth", id: "h" });
    expect(remainingActionIoWaitMs(legacy, 120000, 0, 50000)).toBe(120000);
    expect(() => assertActionIoDeadline(legacy, 30000, 0, 50000)).not.toThrow();
  });
});

describe("I/O remaining long-poll wait", () => {
  it("charges queued time, reserves response time and preserves the original request", () => {
    const read = bridgeSingleCommandSchema.parse({
      method: "agent.action.readIo",
      id: "read",
      params: { execution_id: "e", after_sequence: 7, max_bytes: 65536, wait_ms: 20000 },
    });
    const remaining = remainingActionIoWaitMs(read, 30000, 0, 18000);
    expect(limitActionIoReadWait(read, remaining)).toEqual({
      ...read,
      params: { ...read.params, wait_ms: 7000 },
    });
    expect((read.params as Record<string, unknown>).wait_ms).toBe(20000);
    expect(limitActionIoReadWait(read, 4000)).toEqual({
      ...read,
      params: { ...read.params, wait_ms: 0 },
    });
    expect(limitActionIoReadWait(read, 30000)).toEqual(read);
  });
  it("preserves mutations, batches, and explicit nonwaiting reads", () => {
    expect(limitActionIoReadWait(command, 10)).toBe(command);
    const batch = [command];
    expect(limitActionIoReadWait(batch, 10)).toBe(batch);
    const read = { method: "agent.action.readIo", params: { wait_ms: 0 } };
    expect(limitActionIoReadWait(read, 10)).toBe(read);
  });
});

it("overwrites caller budgets with the remaining hub deadline without mutating bytes", () => {
  const payload = { ...command, meta: { trace_id: "trace", action_io_remaining_ms: 999999 } };
  expect(applyActionIoDeadline(command, payload, 1234.9, 10000)).toEqual({
    ...payload,
    meta: { trace_id: "trace", action_io_remaining_ms: 1234, action_io_deadline_unix_ms: 11234 },
  });
  expect(payload.meta.action_io_remaining_ms).toBe(999999);
  expect(applyActionIoDeadline(command, command, 0, 10000)).toEqual({
    ...command,
    meta: { action_io_remaining_ms: 0, action_io_deadline_unix_ms: 10000 },
  });
  const legacy = bridgeSingleCommandSchema.parse({ method: "agent.getHealth", id: "h" });
  expect(applyActionIoDeadline(legacy, legacy, 10)).toBe(legacy);
});
