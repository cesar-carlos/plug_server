import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { ActionIoSession } from "./action_io_session";
import { io } from "socket.io-client";
import { ActionIoReferenceClient, type ActionIoTransport } from "./action_io_reference_client";
import { createRestActionIoTransport } from "./action_io_rest_transport";
import { createSocketActionIoTransport } from "./action_io_socket_transport";

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Missing " + name);
  return value;
}
async function main(): Promise<void> {
  const [mode, directory] = process.argv.slice(2);
  if (!directory || !["rest", "socket"].includes(mode ?? ""))
    throw new Error("Expected rest|socket and a checkpoint directory");
  const url = new URL(setting("PLUG_HUB_URL")).origin;
  const agentId = setting("PLUG_AGENT_ID");
  const clientId = setting("PLUG_CLIENT_ID");
  const name = setting("PLUG_ACTION_NAME");
  const bearer = () => setting("PLUG_HUB_TOKEN");
  const credential = () => setting("PLUG_AGENT_TOKEN");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let cleanup = () => {};
  try {
    let transport: ActionIoTransport;
    if (mode === "rest") {
      transport = createRestActionIoTransport({
        endpoint: url + "/api/v1/agents/commands",
        agentId,
        bearerToken: bearer,
      });
    } else {
      const socket = io(url + "/consumers", {
        auth: { token: bearer() },
        transports: ["websocket"],
        autoConnect: false,
        reconnection: false,
      });
      cleanup = () => socket.disconnect();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Hub connection timed out")), 10000);
        socket.once("connection:ready", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("connect_error", () => {
          clearTimeout(timer);
          reject(new Error("Hub connection refused"));
        });
        socket.connect();
      });
      const adapter = createSocketActionIoTransport({ socket, agentId });
      cleanup = () => {
        adapter.dispose();
        socket.disconnect();
      };
      transport = adapter;
    }
    const client = new ActionIoReferenceClient(transport, credential);
    const first = Buffer.from([0, 13, 10, 255]);
    const second = Buffer.from([26]);
    const session = await ActionIoSession.open(
      client,
      directory,
      { url, agentId, clientId, name, ...(process.env.PLUG_TRIGGER_ID ? { triggerId: process.env.PLUG_TRIGGER_ID } : {}) },
      first,
    );
    await session.write("interactive", second);
    if (process.argv.includes("--stop-after-input")) {
      console.log("Input confirmed; resume with the same directory");
      return;
    }
    await session.close("close");
    const expected = { stdout: Buffer.concat([first, second]), stderr: Buffer.from("EOF\r\n") };
    const position = await session.consume(
      { stdout: 0, stderr: 0, exit: false, complete: false },
      async (events, previous) => {
        const next = { ...previous };
        for (const event of events) {
          if (event.type === "output") {
            assert.equal(event.offset, next[event.stream]);
            assert.deepEqual(
              Buffer.from(event.bytes),
              expected[event.stream].subarray(event.offset, event.offset + event.bytes.length),
            );
            next[event.stream] += event.bytes.length;
          } else if (event.type === "process_exited") {
            assert.equal(event.exitCode, 0);
            next.exit = true;
          } else if (event.type === "completed") {
            assert.equal(event.complete, true);
            next.complete = true;
          } else throw new Error("Capture failed");
        }
        return next;
      },
    );
    assert.ok(position.exit && position.complete);
    assert.equal(position.stdout, expected.stdout.length);
    assert.equal(position.stderr, expected.stderr.length);
    console.log("Verified echo execution", session.executionId);
  } finally {
    cleanup();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Echo test failed");
  process.exitCode = 1;
});
