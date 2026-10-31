import {
  actionExecutionResultSchema,
  actionValidateRunResultSchema,
  actionCancelResultSchema,
} from "./action_execution_result";
import type { ActionIoBatchExpectation } from "./action_io_response_expectation";
import {
  matchesActionIoExpectation,
  type ActionIoResponseExpectation,
} from "./action_io_response_expectation";
import { isRecord } from "../utils/rpc_types";
import { z } from "zod";
import { actionIoBlockSchema, ACTION_IO_BLOCK_BYTES, ACTION_IO_PAGE_BYTES } from "./action_io";
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identity = z.string().min(1);
const receipt = z
  .object({
    execution_id: identity,
    message_id: identity,
    sequence: integer,
    state: z.enum(["accepted", "writing", "written", "failed", "unknown"]),
    confirmed_bytes: integer.max(ACTION_IO_BLOCK_BYTES).nullable(),
    next_input_sequence: integer,
    stdin_state: z.enum(["pending", "open", "closing", "closed", "failed"]),
  })
  .strict()
  .refine((value) => value.state !== "written" || value.confirmed_bytes !== null, {
    message: "Written input requires confirmed byte progress",
  });
const failure = z
  .object({
    code: identity,
    phase: identity,
    origin: identity,
    diagnostic_id: identity,
    effects_possible: z.boolean(),
    retryable: z.literal(false),
    recovery: identity,
    confirmed_bytes: integer.nullable().optional(),
  })
  .strict();
const event = z.discriminatedUnion("type", [
  z
    .object({
      sequence: integer.min(1),
      type: z.literal("output"),
      stream: z.enum(["stdout", "stderr"]),
      offset: integer,
      data_base64: actionIoBlockSchema,
    })
    .strict(),
  z
    .object({
      sequence: integer.min(1),
      type: z.literal("process_exited"),
      exit_code: z.number().int().nullable(),
    })
    .strict(),
  z
    .object({
      sequence: integer.min(1),
      type: z.literal("completed"),
      output_complete: z.boolean(),
      failure: failure.optional(),
    })
    .strict(),
]);
const page = z
  .object({
    execution_id: identity,
    events: z.array(event).max(256),
    next_sequence: integer,
    terminal: z.boolean(),
    output_complete: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    let bytes = 0;
    let previous = 0;
    const offsets = new Map<"stdout" | "stderr", number>();
    for (const item of value.events) {
      if (item.sequence <= previous)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Non-increasing event sequence" });
      previous = item.sequence;
      if (item.type === "output") {
        const length = Buffer.byteLength(item.data_base64, "base64");
        const expectedOffset = offsets.get(item.stream);
        const end = item.offset + length;
        if (
          (expectedOffset !== undefined && item.offset !== expectedOffset) ||
          !Number.isSafeInteger(end)
        )
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid stream byte offsets" });
        offsets.set(item.stream, end);
        bytes += length;
      }
    }
    if (
      bytes > ACTION_IO_PAGE_BYTES ||
      (value.events.length > 0 && value.next_sequence !== previous)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid page byte limit or cursor" });
    }
  });
const found = z.discriminatedUnion("found", [
  z.object({ found: z.literal(true), execution_id: identity }).strict(),
  z
    .object({
      found: z.literal(false),
      execution_id: z.null(),
      reason: z.literal("not_found_in_retention_window"),
    })
    .strict(),
]);
const results: Readonly<Record<string, z.ZodType>> = {
  "agent.action.run": actionExecutionResultSchema,
  "agent.action.getExecution": actionExecutionResultSchema,
  "agent.action.validateRun": actionValidateRunResultSchema,
  "agent.action.cancel": actionCancelResultSchema,
  "agent.action.sendInput": receipt,
  "agent.action.closeInput": receipt,
  "agent.action.getInputStatus": receipt,
  "agent.action.readIo": page,
  "agent.action.listAvailable": z
    .object({
      actions: z
        .array(
          z
            .object({
              action_id: identity,
              name: z.string().min(1),
              trigger_ids: z.array(identity),
              io_eligible: z.boolean(),
              public_description: z.string().max(512).nullable(),
              stdin_description: z.string().max(512).nullable(),
              stdout_description: z.string().max(512).nullable(),
              stderr_description: z.string().max(512).nullable(),
            })
            .strict(),
        )
        .max(50),
      next_cursor: z.string().min(1).max(128).nullable(),
    })
    .strict(),
  "agent.action.findExecution": found,
};
/** Validate the selected method only; never accept another method's result union. */
export const isValidActionIoResult = (method: string, result: unknown): boolean => {
  if (!Object.hasOwn(results, method)) return false;
  const schema = results[method];
  if (!schema || !schema.safeParse(result).success) return false;
  try {
    return Buffer.byteLength(JSON.stringify(result), "utf8") <= 512 * 1024;
  } catch {
    return false;
  }
};

/** General JSON-RPC envelope validation runs before this method-specific check. */
export const isValidActionIoResponse = (
  method: string | undefined,
  response: unknown,
  expected?: ActionIoResponseExpectation,
): boolean => {
  if (!method || !Object.hasOwn(results, method)) return true;
  if (!isRecord(response)) return false;
  const executionMethod = [
    "agent.action.run",
    "agent.action.getExecution",
    "agent.action.validateRun",
    "agent.action.cancel",
  ].includes(method);
  const result = isRecord(response.result) ? response.result : undefined;
  const execution =
    method === "agent.action.cancel" && isRecord(result?.execution) ? result.execution : result;
  if (executionMethod && !expected?.faithfulIo && (!execution || !Object.hasOwn(execution, "io")))
    return true;
  if (
    !Object.hasOwn(response, "error") &&
    method !== "agent.action.validateRun" &&
    executionMethod &&
    (!execution || !isRecord(execution.io))
  )
    return false;
  if (
    method === "agent.action.cancel" &&
    result &&
    execution &&
    (result.execution_id !== execution.execution_id || result.status !== execution.status)
  )
    return false;
  // The negotiated budget includes correlation metadata and error envelopes.
  try {
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > 512 * 1024) return false;
  } catch {
    return false;
  }
  if (Object.hasOwn(response, "error")) return !Object.hasOwn(response, "result");
  return (
    // The envelope above already includes the entire result in its byte budget.
    results[method]!.safeParse(response.result).success &&
    (!expected || matchesActionIoExpectation(response.result, expected))
  );
};

export const isValidActionIoBatchResponse = (
  expected: readonly ActionIoBatchExpectation[] | undefined,
  response: unknown,
): boolean => {
  if (!expected || expected.length === 0) return true;
  if (!Array.isArray(response) || response.length !== expected.length) return false;
  const remaining = new Map(expected.map((item) => [item.id, item]));
  for (const item of response) {
    if (!isRecord(item) || (typeof item.id !== "string" && typeof item.id !== "number"))
      return false;
    const request = remaining.get(item.id);
    if (!request || !isValidActionIoResponse(request.method, item, request.expected)) return false;
    remaining.delete(item.id);
  }
  return remaining.size === 0;
};
