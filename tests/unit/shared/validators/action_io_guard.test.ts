import { describe, expect, it } from "vitest";
import {
  assertActionIoTransport,
  requiresActionIoCapability,
} from "../../../../src/application/agent_commands/action_io_transport_guard";
import { ACTION_IO_TRANSPORT } from "../../../../src/shared/constants/action_io_transport";
const extensions = {
  binaryPayload: true,
  transportFrame: "payload-frame/1.0",
  agentActions: { enabled: true, version: 1, io: ACTION_IO_TRANSPORT },
};
const transport = {
  protocols: ["jsonrpc-v2"],
  encodings: ["json"],
  compressions: ["none", "gzip"],
  limits: {
    max_payload_bytes: 524288,
    max_decoded_payload_bytes: 524288,
    max_compressed_payload_bytes: 524288,
  },
};
const command = { method: "agent.action.run", params: { io: { version: 1 } } };
describe("live action I/O transport guard", () => {
  it("keeps legacy actions independent of I/O negotiation", () => {
    expect(requiresActionIoCapability({ method: "agent.action.run", params: {} })).toBe(false);
    expect(() =>
      assertActionIoTransport({ method: "agent.action.run", params: {} }, null),
    ).not.toThrow();
  });
  it("remains disabled by the actual hub advertisement", () => {
    expect(() => assertActionIoTransport(command, { ...transport, extensions })).toThrow(
      /not been negotiated/,
    );
  });
  it("requires both peers and detects lost capability on recheck", () => {
    expect(() =>
      assertActionIoTransport(command, { ...transport, extensions }, extensions),
    ).not.toThrow();
    expect(() => assertActionIoTransport(command, null, extensions)).toThrow();
    expect(() => assertActionIoTransport(command, { ...transport, extensions }, {})).toThrow();
    expect(() =>
      assertActionIoTransport(
        command,
        { ...transport, extensions: { ...extensions, binaryPayload: false } },
        extensions,
      ),
    ).toThrow();
  });
  it.each(["sendInput", "closeInput", "getInputStatus", "readIo", "findExecution"])(
    "recognizes %s",
    (method) => {
      expect(requiresActionIoCapability({ method: `agent.action.${method}` })).toBe(true);
    },
  );
  it("rejects mutations and waiting reads in batches", () => {
    for (const item of [
      command,
      { method: "agent.action.sendInput" },
      { method: "agent.action.closeInput" },
      { method: "agent.action.readIo", params: { wait_ms: 1 } },
    ]) {
      expect(() =>
        assertActionIoTransport([item], { ...transport, extensions }, extensions),
      ).toThrow(/cannot be batched/);
    }
    expect(() =>
      assertActionIoTransport(
        [{ method: "agent.action.readIo", params: { wait_ms: 0 } }],
        { ...transport, extensions },
        extensions,
      ),
    ).not.toThrow();
  });
});

it("refuses incompatible encodings and insufficient uncompressed capacity", () => {
  const peer = { ...transport, extensions };
  for (const invalid of [
    { ...peer, protocols: ["other"] },
    { ...peer, encodings: ["msgpack"] },
    { ...peer, compressions: ["gzip"] },
    { ...peer, limits: undefined },
    ...Object.keys(transport.limits).map((key) => ({
      ...peer,
      limits: { ...transport.limits, [key]: 524287 },
    })),
  ])
    expect(() => assertActionIoTransport(command, invalid, extensions)).toThrow();
});
