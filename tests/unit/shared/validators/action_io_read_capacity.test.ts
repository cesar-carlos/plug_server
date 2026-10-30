import { describe, expect, it, vi } from "vitest";
import { ActionIoReadCapacity } from "../../../../src/application/agent_commands/action_io_read_capacity";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";
const read = bridgeSingleCommandSchema.parse({
  method: "agent.action.readIo",
  id: "r",
  params: { execution_id: "e", after_sequence: 0, max_bytes: 65536, wait_ms: 20000 },
});
describe("separate I/O read capacity", () => {
  it("reserves control capacity under saturated reads and reuses released reader slots", async () => {
    const capacity = new ActionIoReadCapacity();
    const releaseControl = vi.fn();
    const acquireControl = vi.fn(async () => releaseControl);
    const input = {
      command: read,
      agentId: "a",
      signal: undefined,
      configuredLimit: 1,
      acquireControl,
    };
    const release = await capacity.acquire(input);
    expect(acquireControl).not.toHaveBeenCalled();
    await expect(capacity.acquire(input)).rejects.toMatchObject({ code: "ACTION_IO_READER_LIMIT" });
    const cancel = bridgeSingleCommandSchema.parse({
      method: "agent.action.cancel",
      id: "c",
      params: { execution_id: "e" },
    });
    const stop = await capacity.acquire({ ...input, command: cancel });
    expect(acquireControl).toHaveBeenCalledOnce();
    stop();
    release();
    release();
    const next = await capacity.acquire(input);
    next();
    expect(releaseControl).toHaveBeenCalledOnce();
  });
  it("bounds reads to 32 even with unlimited control config and rejects abandoned admission", async () => {
    const capacity = new ActionIoReadCapacity();
    const acquireControl = vi.fn(async () => () => {});
    const input = {
      command: read,
      agentId: "a",
      signal: undefined,
      configuredLimit: 0,
      acquireControl,
    };
    const releases = [];
    for (let i = 0; i < 32; i++) releases.push(await capacity.acquire(input));
    await expect(capacity.acquire(input)).rejects.toMatchObject({ code: "ACTION_IO_READER_LIMIT" });
    await expect(
      capacity.acquire({ ...input, agentId: "b", signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ACTION_IO_REQUEST_EXPIRED" });
    releases.forEach((release) => release());
    expect(acquireControl).not.toHaveBeenCalled();
  });
});
