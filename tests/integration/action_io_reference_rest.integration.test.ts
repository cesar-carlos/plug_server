import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { ActionIoReferenceClient } from "../../docs/snippets/action_io_reference_client";
import { createRestActionIoTransport } from "../../docs/snippets/action_io_rest_transport";
import { agentCommandBodySchema } from "../../src/shared/validators/agent_command";
import { normalizeAgentRpcResponse } from "../../src/presentation/http/serializers/agent_rpc_response.serializer";

it("round trips binary input and output over owned HTTP with production schemas and normalization", async () => {
  const input = Buffer.from([0, 13, 10, 26, 255, 128, 65]);
  let admitted = Buffer.alloc(0);
  let requests = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = agentCommandBodySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const command = body.command;
      if (Array.isArray(command)) throw Error("Unexpected batch");
      requests++;
      let result: unknown;
      if (command.method === "agent.action.sendInput") {
        admitted = Buffer.from(command.params.data_base64, "base64");
        result = {
          execution_id: "e",
          message_id: "m",
          sequence: 0,
          state: "written",
          confirmed_bytes: admitted.length,
          next_input_sequence: 1,
          stdin_state: "open",
        };
      } else if (command.method === "agent.action.readIo") {
        result = {
          execution_id: "e",
          events: [
            {
              sequence: 1,
              type: "output",
              stream: "stdout",
              offset: 0,
              data_base64: admitted.toString("base64"),
            },
          ],
          next_sequence: 1,
          terminal: false,
          output_complete: false,
        };
      } else throw Error("Unexpected method");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          mode: "bridge",
          agentId: body.agentId,
          response: normalizeAgentRpcResponse({ jsonrpc: "2.0", id: command.id, result }),
        }),
      );
    } catch {
      res.statusCode = 400;
      res.end("invalid fixture request");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const client = new ActionIoReferenceClient(
      createRestActionIoTransport({
        endpoint: `http://127.0.0.1:${port}/api/v1/agents/commands`,
        agentId: "fixture-agent",
        bearerToken: () => "fixture-bearer",
      }),
      () => "fixture-client-token",
    );
    expect(await client.sendInput("e", "m", 0, input)).toMatchObject({
      state: "written",
      confirmed_bytes: input.length,
    });
    const page = await client.readIo("e", 0, 0);
    expect(admitted).toEqual(input);
    expect(page.events).toEqual([
      {
        sequence: 1,
        type: "output",
        stream: "stdout",
        offset: 0,
        data_base64: input.toString("base64"),
      },
    ]);
    expect(requests).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
