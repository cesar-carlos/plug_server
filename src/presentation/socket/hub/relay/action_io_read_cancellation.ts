import { assertCommandTransport } from "../../../../application/agent_commands/command_transport_guard";
import type { BridgeCommand } from "../../../../shared/validators/agent_command";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { encodePayloadFrame } from "../../../../shared/utils/payload_frame";
import { logger } from "../../../../shared/utils/logger";
import { agentRegistry } from "../registries/agent_registry";

/** A route may abandon its read wait without cancelling the underlying process. */
export const createActionIoReadCancellation = (input: {
  readonly command: BridgeCommand;
  readonly logicalRequestId: unknown;
  readonly agentId: string;
  readonly socket: { emit: (event: string, payload: unknown) => void };
  readonly socketId: string;
}): { markDispatched: () => void; cancel: () => void } => {
  let dispatched = false;
  let cancelled = false;
  return {
    markDispatched: () => {
      dispatched = true;
    },
    cancel: () => {
      const command = input.command;
      const id = input.logicalRequestId;
      if (
        !dispatched ||
        cancelled ||
        Array.isArray(command) ||
        command.method !== "agent.action.readIo" ||
        typeof command.params?.wait_ms !== "number" ||
        command.params.wait_ms <= 0 ||
        (typeof id !== "string" && typeof id !== "number")
      )
        return;
      cancelled = true;
      if (
        agentRegistry.getSocketIdByAgentId(input.agentId) !== input.socketId ||
        !agentRegistry.getProtocolReadiness(input.agentId).ready
      )
        return;
      try {
        assertCommandTransport(command, agentRegistry.getCapabilitiesByAgentId(input.agentId));
        const logical = { version: 1, request_id: id };
        if (Buffer.byteLength(JSON.stringify(logical), "utf8") > 1024) {
          logger.warn("action_io_read_cancel_control_too_large");
          return;
        }
        input.socket.emit(
          socketEvents.rpcReadCancel,
          encodePayloadFrame(logical, {
            compressionThreshold: Number.POSITIVE_INFINITY,
            omitTraceId: true,
          }),
        );
      } catch {
        logger.warn("action_io_read_cancel_not_delivered");
      }
    },
  };
};
