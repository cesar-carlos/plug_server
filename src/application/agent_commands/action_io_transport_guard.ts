import {
  capabilityReason,
  capabilityUnavailable,
} from "../../shared/errors/capability_unavailable";
import { buildHubServerCapabilities } from "../../shared/constants/agent_transport_contract";
import { ACTION_IO_TRANSPORT, supportsActionIo } from "../../shared/constants/action_io_transport";
import { AppError } from "../../shared/errors/app_error";
import { isRecord } from "../../shared/utils/rpc_types";

interface IoCommand {
  readonly method: string;
  readonly params?: unknown;
  readonly id?: unknown;
}
const ioMethods = new Set([
  "agent.action.sendInput",
  "agent.action.closeInput",
  "agent.action.getInputStatus",
  "agent.action.readIo",
  "agent.action.listAvailable",
  "agent.action.findExecution",
]);
export const requiresActionIoCapability = (command: IoCommand | readonly IoCommand[]): boolean =>
  (Array.isArray(command) ? command : [command]).some(
    (item: IoCommand) =>
      ioMethods.has(item.method) ||
      ((item.method === "agent.action.run" || item.method === "agent.action.validateRun") &&
        isRecord(item.params) &&
        Object.hasOwn(item.params, "io")),
  );

/** Call with the live authenticated registration, never caller-supplied capabilities. */
export const assertActionIoTransport = (
  command: IoCommand | readonly IoCommand[],
  capabilities: Record<string, unknown> | null,
  hubExtensions: Readonly<Record<string, unknown>> = buildHubServerCapabilities().extensions,
): void => {
  if (!requiresActionIoCapability(command)) return;
  const items: readonly IoCommand[] = Array.isArray(command) ? command : [command];
  if (items.some((item) => item.id === null && requiresActionIoCapability(item))) {
    throw new AppError("O I/O remoto exige uma resposta. Envie um identificador JSON-RPC válido.", {
      statusCode: 400,
      code: "ACTION_IO_INVALID_REQUEST",
      details: { retryable: false, effects_possible: false },
    });
  }
  const extensions =
    capabilities && isRecord(capabilities.extensions) ? capabilities.extensions : null;
  const compatible = (value: unknown): boolean => {
    if (
      !isRecord(value) ||
      value.binaryPayload !== true ||
      value.transportFrame !== "payload-frame/1.0"
    )
      return false;
    const actions = value.agentActions;
    return (
      isRecord(actions) &&
      actions.enabled === true &&
      actions.version === 1 &&
      supportsActionIo(actions.io)
    );
  };
  const includes = (value: unknown, required: string): boolean =>
    Array.isArray(value) && value.includes(required);
  const limits = capabilities && isRecord(capabilities.limits) ? capabilities.limits : null;
  const supportsUncompressedJson =
    capabilities !== null &&
    includes(capabilities.protocols, "jsonrpc-v2") &&
    includes(capabilities.encodings, "json") &&
    includes(capabilities.compressions, "none") &&
    limits !== null &&
    ["max_payload_bytes", "max_decoded_payload_bytes", "max_compressed_payload_bytes"].every(
      (key) => {
        const value = limits[key];
        return (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= ACTION_IO_TRANSPORT.max_json_bytes
        );
      },
    );
  const needsCatalog = items.some((item) => item.method === "agent.action.listAvailable");
  for (const [origin, value] of [
    ["hub", hubExtensions],
    ["agent", extensions],
  ] as const) {
    if (needsCatalog) {
      const actions = isRecord(value) ? value.agentActions : undefined;
      const catalog =
        isRecord(actions) && actions.enabled !== false ? actions.catalogVersion : actions;
      if (catalog !== 1) {
        throw capabilityUnavailable("agentActions.catalog v1", capabilityReason(catalog), origin);
      }
    }
    if (!compatible(value)) {
      const actions = isRecord(value) ? value.agentActions : undefined;
      const advertised =
        isRecord(actions) && actions.enabled === true && actions.version === 1
          ? actions.io
          : actions;
      throw capabilityUnavailable("agentActions.io v1", capabilityReason(advertised), origin);
    }
  }
  if (!supportsUncompressedJson) throw capabilityUnavailable("agentActions.io v1", "incompatible");
  if (
    Array.isArray(command) &&
    command.some(
      (item: IoCommand) =>
        item.method === "agent.action.run" ||
        item.method === "agent.action.sendInput" ||
        item.method === "agent.action.closeInput" ||
        item.method === "agent.action.cancel" ||
        (item.method === "agent.action.readIo" &&
          isRecord(item.params) &&
          Number(item.params.wait_ms) > 0),
    )
  ) {
    throw new AppError("I/O mutations and waiting reads cannot be batched.", {
      statusCode: 400,
      code: "ACTION_IO_BATCH_FORBIDDEN",
      details: { retryable: false },
    });
  }
};
