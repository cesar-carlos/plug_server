import { container } from "../../../../shared/di/container";
import {
  noteAgentAutoUpdateDiagnosticsReceived,
  noteAgentAutoUpdateDiagnosticsValidationDrop,
} from "../../../../shared/metrics/socket_agent.metrics";
import { decodePayloadFrameAsync } from "../../../../shared/utils/payload_frame";
import { logger } from "../../../../shared/utils/logger";
import type { AgentHubSocket } from "./_shared";

const jsonByteLength = (value: unknown): number | null => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
};

export const handleAgentAutoUpdateDiagnosticsRpcRequest = async (
  socket: AgentHubSocket,
  rawPayload: unknown,
): Promise<void> => {
  const authenticatedAgentId = socket.data.agentId;
  if (!authenticatedAgentId) {
    noteAgentAutoUpdateDiagnosticsReceived();
    noteAgentAutoUpdateDiagnosticsValidationDrop();
    logger.warn("agent_auto_update_diagnostics_validation_drop", {
      socketId: socket.id,
      reason: "received before agent registration",
    });
    return;
  }

  const decoded = await decodePayloadFrameAsync(rawPayload);
  if (!decoded.ok) {
    noteAgentAutoUpdateDiagnosticsReceived();
    noteAgentAutoUpdateDiagnosticsValidationDrop();
    logger.warn("agent_auto_update_diagnostics_validation_drop", {
      socketId: socket.id,
      agentId: authenticatedAgentId,
      reason: decoded.error.message,
    });
    return;
  }

  const result = await container.agentAutoUpdateDiagnosticsService.ingestNotification({
    authenticatedAgentId,
    socketId: socket.id,
    notification: decoded.value.data,
    messageBytes: jsonByteLength(rawPayload),
  });

  if (result.status !== "accepted" && result.status !== "rate_limited_drop") {
    logger.debug("agent_auto_update_diagnostics_not_accepted", {
      socketId: socket.id,
      agentId: authenticatedAgentId,
      status: result.status,
      reason: result.reason,
    });
  }
};
