import type { BridgeBatchCommand, BridgeCommand } from "../validators/agent_command";
import { toRequestId } from "./rpc_types";

export const isBatchCommand = (command: BridgeCommand): command is BridgeBatchCommand => {
  return Array.isArray(command);
};

export const toCorrelationIds = (command: BridgeCommand): readonly string[] => {
  if (isBatchCommand(command)) {
    const ids: string[] = [];
    for (const item of command) {
      const id = toRequestId(item.id);
      if (id) {
        ids.push(id);
      }
    }
    return ids;
  }

  const singleId = toRequestId(command.id);
  return singleId ? [singleId] : [];
};
