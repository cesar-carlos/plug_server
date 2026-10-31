import { isRecord } from "../utils/rpc_types";

/** Safe correlation metadata only; never retain input bytes or credentials here. */
export interface ActionIoResponseExpectation {
  readonly faithfulIo?: boolean;
  readonly actionId?: string;
  readonly executionId?: string;
  readonly messageId?: string;
  readonly sequence?: number;
  readonly afterSequence?: number;
  readonly maxBytes?: number;
  readonly inputBytes?: number;
}
export const captureActionIoExpectation = (command: unknown): ActionIoResponseExpectation => {
  if (
    !isRecord(command) ||
    typeof command.method !== "string" ||
    !command.method.startsWith("agent.action.") ||
    !isRecord(command.params)
  )
    return {};
  const p = command.params;
  const inputBytes =
    command.method === "agent.action.closeInput"
      ? 0
      : command.method === "agent.action.sendInput" && typeof p.data_base64 === "string"
        ? Buffer.byteLength(p.data_base64, "base64")
        : undefined;
  return {
    ...(Object.hasOwn(p, "io") ? { faithfulIo: true } : {}),
    ...(Object.hasOwn(p, "io") && typeof p.action_id === "string" ? { actionId: p.action_id } : {}),
    ...(inputBytes !== undefined ? { inputBytes } : {}),
    ...(typeof p.execution_id === "string" ? { executionId: p.execution_id } : {}),
    ...(typeof p.message_id === "string" ? { messageId: p.message_id } : {}),
    ...(typeof p.sequence === "number" ? { sequence: p.sequence } : {}),
    ...(typeof p.after_sequence === "number" ? { afterSequence: p.after_sequence } : {}),
    ...(typeof p.max_bytes === "number" ? { maxBytes: p.max_bytes } : {}),
  };
};
export const matchesActionIoExpectation = (
  result: unknown,
  expected: ActionIoResponseExpectation,
): boolean => {
  if (!isRecord(result)) return false;
  if (expected.actionId !== undefined && result.action_id !== expected.actionId) return false;
  if (expected.executionId !== undefined && result.execution_id !== expected.executionId)
    return false;
  if (expected.messageId !== undefined && result.message_id !== expected.messageId) return false;
  if (expected.sequence !== undefined && result.sequence !== expected.sequence) return false;
  if (
    expected.inputBytes !== undefined &&
    result.state === "written" &&
    result.confirmed_bytes !== expected.inputBytes
  )
    return false;
  if (
    expected.inputBytes !== undefined &&
    typeof result.confirmed_bytes === "number" &&
    result.confirmed_bytes > expected.inputBytes
  )
    return false;
  if (expected.afterSequence !== undefined) {
    if (!Array.isArray(result.events)) return false;
    if (result.events.length === 0 && result.next_sequence !== expected.afterSequence) return false;
    let bytes = 0;
    for (const event of result.events) {
      if (
        !isRecord(event) ||
        typeof event.sequence !== "number" ||
        event.sequence <= expected.afterSequence
      )
        return false;
      if (event.type === "output" && typeof event.data_base64 === "string")
        bytes += Buffer.from(event.data_base64, "base64").length;
    }
    if (expected.maxBytes !== undefined && bytes > expected.maxBytes) return false;
  }
  return true;
};

export interface ActionIoBatchExpectation {
  readonly id: string | number;
  readonly method: string;
  readonly expected: ActionIoResponseExpectation;
}
export const captureActionIoBatch = (command: unknown): readonly ActionIoBatchExpectation[] => {
  if (
    !Array.isArray(command) ||
    !command.some(
      (item) =>
        isRecord(item) &&
        typeof item.method === "string" &&
        ((item.method === "agent.action.validateRun" &&
          isRecord(item.params) &&
          Object.hasOwn(item.params, "io")) ||
          [
            "agent.action.readIo",
            "agent.action.getInputStatus",
            "agent.action.listAvailable",
  "agent.action.findExecution",
          ].includes(item.method)),
    )
  )
    return [];
  return command.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.method !== "string" ||
      (typeof item.id !== "string" && typeof item.id !== "number")
    )
      return [];
    return [{ id: item.id, method: item.method, expected: captureActionIoExpectation(item) }];
  });
};
