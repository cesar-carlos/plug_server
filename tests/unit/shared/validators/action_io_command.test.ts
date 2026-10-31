import { isAckRetryEligibleCommand } from "../../../../src/presentation/socket/hub/relay/rpc_bridge_command_helpers";
import { describe, expect, it } from "vitest";
import { bridgeSingleCommandSchema } from "../../../../src/shared/validators/agent_command";
import {
  assertCommandTransport,
  requiresLiveCommandCapability,
} from "../../../../src/application/agent_commands/command_transport_guard";
const requests = [
  {
    method: "agent.action.sendInput",
    params: { execution_id: "e", message_id: "m", sequence: 0, data_base64: "AP8NCho=" },
  },
  {
    method: "agent.action.closeInput",
    params: { execution_id: "e", message_id: "close", sequence: 1 },
  },
  { method: "agent.action.getInputStatus", params: { execution_id: "e", message_id: "m" } },
  {
    method: "agent.action.readIo",
    params: { execution_id: "e", after_sequence: 0, max_bytes: 65536, wait_ms: 20000 },
  },
  { method: "agent.action.findExecution", params: { action_id: "a", idempotency_key: "key" } },
];
describe("I/O bridge command registration", () => {
  it.each(requests)("preserves $method and requires live negotiation", (request) => {
    const wire = { ...request, jsonrpc: "2.0", id: "caller-id" };
    const parsed = bridgeSingleCommandSchema.parse(wire);
    expect(parsed).toEqual(wire);
    expect(requiresLiveCommandCapability(parsed)).toBe(true);
    expect(isAckRetryEligibleCommand(parsed)).toBe(false);
    expect(isAckRetryEligibleCommand([parsed])).toBe(false);
    expect(() => assertCommandTransport(parsed, null)).toThrow(/indisponível/);
    expect(bridgeSingleCommandSchema.safeParse(request).success).toBe(false);
    expect(
      bridgeSingleCommandSchema.safeParse({
        ...wire,
        params: { ...request.params, arbitrary: true },
      }).success,
    ).toBe(false);
  });
  it.each(["agent.action.run", "agent.action.validateRun"])(
    "preserves optional I/O and trigger in %s",
    (method) => {
      const legacy = {
        jsonrpc: "2.0",
        id: "caller",
        method,
        params: { action_id: "a", idempotency_key: "k", trigger_id: "t" },
      };
      expect(bridgeSingleCommandSchema.parse(legacy)).toEqual(legacy);
      const faithful = {
        ...legacy,
        params: {
          ...legacy.params,
          io: { version: 1, mode: "faithful", close_input: false, initial_input_base64: "" },
        },
      };
      expect(bridgeSingleCommandSchema.parse(faithful)).toEqual(faithful);
      expect(() =>
        assertCommandTransport(bridgeSingleCommandSchema.parse(faithful), null),
      ).toThrow();
    },
  );
});
