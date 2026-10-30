import { expect, it } from "vitest";
import {
  ActionIoReferenceClient,
  ActionIoClientError,
  type ActionIoCommand,
} from "../../../docs/snippets/action_io_reference_client";
const receipt = {
  execution_id: "e",
  message_id: "m",
  sequence: 0,
  state: "accepted",
  confirmed_bytes: 0,
  next_input_sequence: 1,
  stdin_state: "open",
};
it("preserves binary input including empty blocks without appending newlines", async () => {
  const commands: ActionIoCommand[] = [];
  const client = new ActionIoReferenceClient(
    async (command) => {
      commands.push(command);
      return { jsonrpc: "2.0", id: command.id, result: receipt };
    },
    () => "credential",
  );
  await client.sendInput("e", "m", 0, Uint8Array.from([0, 13, 10, 26, 255]));
  expect(commands[0]?.params.data_base64).toBe("AA0KGv8=");
  await client.sendInput("e", "m", 0, new Uint8Array());
  expect(commands[1]?.params.data_base64).toBe("");
});
it("does not retry uncertain mutations and allows explicit status reconciliation", async () => {
  let calls = 0;
  const client = new ActionIoReferenceClient(
    async (command) => {
      calls++;
      if (command.method === "agent.action.sendInput") throw Error("disconnected");
      return {
        jsonrpc: "2.0",
        id: command.id,
        result: { ...receipt, state: "unknown", confirmed_bytes: null },
      };
    },
    () => "credential",
  );
  await expect(client.sendInput("e", "m", 0, new Uint8Array())).rejects.toMatchObject({
    outcomeUnknown: true,
  });
  expect(calls).toBe(1);
  expect(await client.getInputStatus("e", "m")).toMatchObject({
    state: "unknown",
    confirmed_bytes: null,
  });
  expect(calls).toBe(2);
});
it("keeps absent initial input distinct from an explicit empty block", async () => {
  const commands: ActionIoCommand[] = [];
  const client = new ActionIoReferenceClient(
    async (command) => {
      commands.push(command);
      throw Error("disconnected");
    },
    () => "credential",
  );
  await expect(client.run("a", "k")).rejects.toBeInstanceOf(ActionIoClientError);
  await expect(
    client.run("a", "k", { initial: new Uint8Array(), closeInput: true }),
  ).rejects.toBeInstanceOf(ActionIoClientError);
  expect(commands[0]?.params.io).not.toHaveProperty("initial_input_base64");
  expect(commands[1]?.params.io).toMatchObject({ initial_input_base64: "", close_input: true });
});
it("returns a validated resumable cursor without consuming or rewriting output", async () => {
  const client = new ActionIoReferenceClient(
    async (command) => {
      expect(command.params.after_sequence).toBe(7);
      return {
        jsonrpc: "2.0",
        id: command.id,
        result: {
          execution_id: "e",
          events: [
            { sequence: 8, type: "output", stream: "stdout", offset: 0, data_base64: "AP8=" },
          ],
          next_sequence: 8,
          terminal: false,
          output_complete: false,
        },
      };
    },
    () => "credential",
  );
  const page = await client.readIo("e", 7, 0);
  expect(page.next_sequence).toBe(8);
  expect(page.events).toEqual([
    { sequence: 8, type: "output", stream: "stdout", offset: 0, data_base64: "AP8=" },
  ]);
});
it("refuses oversized input before transport and rejects mismatched response IDs", async () => {
  let calls = 0;
  const client = new ActionIoReferenceClient(
    async () => {
      calls++;
      return { jsonrpc: "2.0", id: "other", result: receipt };
    },
    () => "credential",
  );
  await expect(client.sendInput("e", "m", 0, new Uint8Array(65537))).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    outcomeUnknown: false,
  });
  expect(calls).toBe(0);
  await expect(client.sendInput("e", "m", 0, new Uint8Array())).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    outcomeUnknown: true,
  });
});

it("preserves a transport refusal before dispatch instead of claiming unknown effects", async () => {
  const failure = new ActionIoClientError("SOCKET_NOT_CONNECTED", false);
  const client = new ActionIoReferenceClient(
    async () => {
      throw failure;
    },
    () => "credential",
  );
  await expect(client.sendInput("e", "m", 0, new Uint8Array())).rejects.toBe(failure);
});

it("keeps structured remote diagnostics and recovery without copying arbitrary data", async () => {
  const client = new ActionIoReferenceClient(
    async (command) => ({
      jsonrpc: "2.0",
      id: command.id,
      error: {
        code: -32000,
        message: "private command line",
        data: {
          code: "ACTION_STDIN_WRITE_TIMEOUT",
          phase: "stdin_write",
          origin: "runner",
          diagnostic_id: "diag-1",
          execution_id: "e",
          message_id: "m",
          delivery_state: "unknown",
          confirmed_bytes: null,
          effects_possible: true,
          recovery: "query_message",
          secret: "never expose",
        },
      },
    }),
    () => "credential",
  );
  const failure = await client
    .sendInput("e", "m", 0, new Uint8Array())
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "ACTION_STDIN_WRITE_TIMEOUT",
    rpcCode: -32000,
    outcomeUnknown: true,
    details: {
      diagnostic_id: "diag-1",
      recovery: "query_message",
      delivery_state: "unknown",
      confirmed_bytes: null,
    },
  });
  expect(JSON.stringify(failure)).not.toContain("never expose");
  expect(String(failure)).not.toContain("private command line");
});
