import { describe, expect, it, vi } from "vitest";
import { reconcileRun, writeConfirmed } from "../../../docs/snippets/action_io_checkpoint";
import {
  ActionIoClientError,
  ActionIoReferenceClient,
} from "../../../docs/snippets/action_io_reference_client";

describe("durable action I/O recovery", () => {
  it("recovers a lost run acknowledgement with the original key", async () => {
    const client = new ActionIoReferenceClient(vi.fn(), () => "fixture");
    const find = vi
      .spyOn(client, "findExecution")
      .mockResolvedValue({ found: true, execution_id: "e" });
    const send = vi.fn().mockRejectedValue(new ActionIoClientError("TRANSPORT_UNCONFIRMED", true));
    expect(await reconcileRun(client, "a", "key", send)).toBe("e");
    expect(send).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith("a", "key");
    find.mockResolvedValue({ found: false });
    await expect(reconcileRun(client, "a", "key")).rejects.toThrow("outcome unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("checks original receipt after lost input acknowledgement without resending", async () => {
    const client = new ActionIoReferenceClient(vi.fn(), () => "fixture");
    const receipt = vi.spyOn(client, "getInputStatus").mockResolvedValue({ state: "written" });
    const send = vi.fn().mockRejectedValue(new ActionIoClientError("SOCKET_DISCONNECTED", true));
    await writeConfirmed(client, "e", "m", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledWith("e", "m");
    receipt.mockResolvedValue({ state: "unknown" });
    await expect(writeConfirmed(client, "e", "m")).rejects.toThrow("unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
