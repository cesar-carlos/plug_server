import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server, type Socket } from "socket.io";
import { io } from "socket.io-client";
import { expect, it } from "vitest";
import { probeActionIoClock } from "../../src/presentation/socket/hub/relay/action_io_clock_probe";
import { bridgeSingleCommandSchema } from "../../src/shared/validators/agent_command";

it("negotiates a bounded monotonic deadline using a real Socket.IO ACK", async () => {
  const http = createServer();
  const hub = new Server(http);
  const connected = new Promise<Socket>((resolve) => hub.once("connection", resolve));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const client = io("http://127.0.0.1:" + (http.address() as AddressInfo).port, {
    transports: ["websocket"],
    reconnection: false,
  });
  const command = bridgeSingleCommandSchema.parse({
    method: "agent.action.listAvailable",
    id: "catalog",
    params: {},
  });
  const extensions = { agentActions: { deadlineClock: 1 } };
  try {
    const socket = await connected;
    const started = performance.now();
    const offset = 86400000; // Different clock origin, intentionally unrelated to UTC.
    client.on("rpc:clock.probe", (request: unknown, ack: (value: unknown) => void) => {
      expect(request).toEqual({ version: 1 });
      const sampled = Math.floor(performance.now() + offset);
      setTimeout(() => ack({ version: 1, clock_id: "live-session", monotonic_ms: sampled }), 25);
    });
    const budget = await probeActionIoClock(
      command,
      { extensions },
      socket,
      () => 1000 - (performance.now() - started),
      undefined,
      extensions,
    );
    expect(budget?.action_io_clock_id).toBe("live-session");
    expect(budget!.action_io_monotonic_deadline_ms).toBeLessThanOrEqual(started + offset + 1000);
    expect(budget!.action_io_monotonic_deadline_ms).toBeGreaterThan(performance.now() + offset);
    client.removeAllListeners("rpc:clock.probe");
    await expect(
      probeActionIoClock(command, { extensions }, socket, () => 10, undefined, extensions),
    ).rejects.toMatchObject({ code: "ACTION_IO_REQUEST_EXPIRED" });
  } finally {
    client.disconnect();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});
