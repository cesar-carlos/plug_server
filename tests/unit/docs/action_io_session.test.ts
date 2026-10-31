import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionIoReferenceClient } from "../../../docs/snippets/action_io_reference_client";
import { ActionIoSession } from "../../../docs/snippets/action_io_session";

describe("persistent session", () => {
  it("resumes an empty input block and terminal page without duplicate writes or delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plug-io-unit-"));
    try {
      const client = new ActionIoReferenceClient(vi.fn(), () => "fixture");
      vi.spyOn(client, "listAvailable").mockImplementation(async function* () {
        yield { action_id: "a", name: "echo" };
      });
      vi.spyOn(client, "validateRun").mockResolvedValue({ valid: true });
      const run = vi.spyOn(client, "run").mockResolvedValue({});
      vi.spyOn(client, "findExecution").mockResolvedValue({ found: true, execution_id: "e" });
      const write = vi.spyOn(client, "sendInput").mockResolvedValue({});
      const close = vi.spyOn(client, "closeInput").mockResolvedValue({});
      vi.spyOn(client, "getInputStatus").mockResolvedValue({ state: "written" });
      const read = vi.spyOn(client, "readIo").mockResolvedValue({
        next_sequence: 1,
        events: [{ type: "completed", sequence: 1, output_complete: true }],
      });
      const target = {
        url: "http://localhost",
        agentId: "a",
        clientId: "c",
        name: "echo",
        triggerId: "interactive",
      };
      const first = await ActionIoSession.open(client, directory, target);
      expect(client.validateRun).toHaveBeenCalledWith("a", "interactive");
      expect(run).toHaveBeenCalledWith("a", expect.any(String), { triggerId: "interactive" });
      await expect(
        ActionIoSession.open(client, directory, { ...target, triggerId: "other" }),
      ).rejects.toThrow("different target");
      await first.write("empty", new Uint8Array());
      const resumed = await ActionIoSession.open(client, directory, target);
      await resumed.write("empty", new Uint8Array());
      await expect(resumed.write("empty", new Uint8Array([1]))).rejects.toThrow("Conflicting");
      await resumed.close("end");
      await expect(resumed.write("late", new Uint8Array())).rejects.toThrow("closed");
      const consumer = vi.fn(async () => 1);
      expect(await resumed.consume(0, consumer)).toBe(1);
      expect(await resumed.consume(0, consumer)).toBe(1);
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith("e", expect.any(String), 0, new Uint8Array());
      expect(close).toHaveBeenCalledWith("e", expect.any(String), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
