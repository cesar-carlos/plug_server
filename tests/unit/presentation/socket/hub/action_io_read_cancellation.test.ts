import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionIoReadCancellation } from "../../../../../src/presentation/socket/hub/relay/action_io_read_cancellation";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { assertCommandTransport } from "../../../../../src/application/agent_commands/command_transport_guard";
import { bridgeCommandSchema } from "../../../../../src/shared/validators/agent_command";
vi.mock("../../../../../src/application/agent_commands/command_transport_guard", () => ({
  assertCommandTransport: vi.fn(),
}));
vi.mock("../../../../../src/presentation/socket/hub/registries/agent_registry", () => ({
  agentRegistry: {
    getSocketIdByAgentId: vi.fn(() => "socket"),
    getProtocolReadiness: vi.fn(() => ({ ready: true })),
    getCapabilitiesByAgentId: vi.fn(() => ({})),
  },
}));
const command = bridgeCommandSchema.parse({
  jsonrpc: "2.0",
  id: 7,
  method: "agent.action.readIo",
  params: { execution_id: "e", after_sequence: 0, max_bytes: 65536, wait_ms: 20000 },
});
describe("abandoned read control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentRegistry.getSocketIdByAgentId).mockReturnValue("socket");
    vi.mocked(assertCommandTransport).mockImplementation(() => undefined);
  });
  it("sends the original typed RPC ID once only after dispatch", () => {
    const emit = vi.fn();
    const cancel = createActionIoReadCancellation({
      command,
      logicalRequestId: 7,
      agentId: "agent",
      socketId: "socket",
      socket: { emit },
    });
    cancel.cancel();
    expect(emit).not.toHaveBeenCalled();
    cancel.markDispatched();
    cancel.cancel();
    cancel.cancel();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe("rpc:read.cancel");
    const frame = emit.mock.calls[0]?.[1];
    expect(frame.cmp).toBe("none");
    expect(JSON.parse(Buffer.from(frame.payload).toString("utf8"))).toEqual({
      version: 1,
      request_id: 7,
    });
  });
  it.each(["changed", "capability", "oversized", "non-read"])("does not deliver for %s", (mode) => {
    const emit = vi.fn();
    if (mode === "changed")
      vi.mocked(agentRegistry.getSocketIdByAgentId).mockReturnValue("new-socket");
    if (mode === "capability")
      vi.mocked(assertCommandTransport).mockImplementation(() => {
        throw new Error("unavailable");
      });
    const cancel = createActionIoReadCancellation({
      command:
        mode === "non-read"
          ? bridgeCommandSchema.parse({
              jsonrpc: "2.0",
              id: 7,
              method: "agent.action.cancel",
              params: { execution_id: "e" },
            })
          : command,
      logicalRequestId: mode === "oversized" ? "x".repeat(1024) : 7,
      agentId: "agent",
      socketId: "socket",
      socket: { emit },
    });
    cancel.markDispatched();
    cancel.cancel();
    expect(emit).not.toHaveBeenCalled();
  });
});
