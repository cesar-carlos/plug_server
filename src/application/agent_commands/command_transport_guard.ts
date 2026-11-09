import type { BridgeCommand } from "../../shared/validators/agent_command";
import { assertActionIoTransport } from "./action_io_transport_guard";
import { requiresActionIoDeadline } from "./action_io_deadline";
import {
  assertSqlOperationTransport,
  requiresLiveSqlCapability,
} from "./sql_operation_transport_guard";

export const requiresLiveCommandCapability = (command: BridgeCommand): boolean =>
  requiresLiveSqlCapability(command) || requiresActionIoDeadline(command);

export const assertCommandTransport = (
  command: BridgeCommand,
  capabilities: Record<string, unknown> | null,
): void => {
  assertSqlOperationTransport(command, capabilities);
  assertActionIoTransport(command, capabilities);
};
