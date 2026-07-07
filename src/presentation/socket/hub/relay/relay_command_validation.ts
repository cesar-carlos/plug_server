import { normalizeCommandForAgent } from "../../../../application/agent_commands/command_transformers";
import type { AppError } from "../../../../shared/errors/app_error";
import { badRequest } from "../../../../shared/errors/http_errors";
import {
  bridgeSingleCommandSchema,
  supportedAgentRpcMethods,
  type BridgeSingleCommand,
} from "../../../../shared/validators/agent_command";
import { isRecord } from "../../../../shared/utils/rpc_types";
import { observeRelayCommandValidation } from "./bridge_relay_health_metrics";
import { hasNotificationCommand } from "./rpc_bridge_command_helpers";

const supportedMethodSet = new Set<string>(supportedAgentRpcMethods);

const relayRpcRefundableBadRequestDetails = {
  refundRelayRpcRequestRateLimit: true,
} as const;

/**
 * `badRequest` carrying the `refundRelayRpcRequestRateLimit` detail so the
 * socket consumer handler refunds the relay rate-limit hit (the request never
 * reached the agent — the client should not be penalized for a malformed frame
 * the same way as a successful dispatch).
 */
export const relayRpcRefundableBadRequest = (message: string): AppError =>
  badRequest(message, relayRpcRefundableBadRequestDetails);

/**
 * Validates and normalizes a decoded `relay:rpc.request` command payload:
 * rejects non-object/batch payloads, unsupported methods, schema failures and
 * JSON-RPC notifications (`id: null`); then normalizes for agent dispatch.
 *
 * Throws {@link relayRpcRefundableBadRequest} on any validation failure.
 * Extracted from `dispatchRelayRpcToAgent` so the (well-tested) validation
 * phase is an isolated, independently testable unit.
 */
export const validateAndNormalizeRelayCommand = (
  data: unknown,
): {
  command: BridgeSingleCommand;
  normalizedCommand: ReturnType<typeof normalizeCommandForAgent>;
} => {
  const rawCommand = isRecord(data) ? data : null;
  if (!rawCommand) {
    throw relayRpcRefundableBadRequest(
      "relay:rpc.request frame must contain a JSON object payload",
    );
  }

  if (Array.isArray(rawCommand)) {
    throw relayRpcRefundableBadRequest(
      "relay:rpc.request does not support batch; send a single JSON-RPC request",
    );
  }
  const method = typeof rawCommand.method === "string" ? rawCommand.method : "";
  if (!supportedMethodSet.has(method)) {
    throw relayRpcRefundableBadRequest("command.method: Unsupported RPC method");
  }

  const validateStart = performance.now();
  const parsed = bridgeSingleCommandSchema.safeParse(rawCommand);
  observeRelayCommandValidation(performance.now() - validateStart);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".") || "command"}: ${firstIssue.message}`
      : "Invalid RPC command";
    throw relayRpcRefundableBadRequest(message);
  }

  const command = parsed.data;
  if (hasNotificationCommand(command)) {
    throw relayRpcRefundableBadRequest(
      "relay:rpc.request does not support JSON-RPC notifications (`id: null`); provide a request id",
    );
  }
  const normalizedCommand = normalizeCommandForAgent(command);

  return { command, normalizedCommand };
};

/**
 * Returns `true` when the command may open a relay stream and therefore
 * cannot use the unary `fastPath` opt-in.
 */
export const isRelayStreamingCapableCommand = (command: {
  readonly method: string;
  readonly params?: unknown;
}): boolean => {
  if (command.method === "sql.executeBatch") {
    return true;
  }
  if (command.method !== "sql.execute") {
    return false;
  }
  const params = isRecord(command.params) ? command.params : null;
  const options = params && isRecord(params.options) ? params.options : null;
  return options?.prefer_db_streaming === true || options?.multi_result === true;
};
