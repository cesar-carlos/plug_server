import type { BridgeCommand } from "../../shared/validators/agent_command";
import { AppError } from "../../shared/errors/app_error";
import { requiresActionIoCapability } from "./action_io_transport_guard";

export const remainingActionIoWaitMs = (
  command: BridgeCommand,
  timeoutMs: number,
  startedAt: number,
  now = performance.now(),
): number =>
  requiresActionIoCapability(command)
    ? Math.max(0, Math.ceil(Math.min(timeoutMs, 30000) - (now - startedAt)))
    : timeoutMs;

export const assertActionIoDeadline = (
  command: BridgeCommand,
  timeoutMs: number,
  startedAt: number,
  now = performance.now(),
): void => {
  if (
    requiresActionIoCapability(command) &&
    remainingActionIoWaitMs(command, timeoutMs, startedAt, now) === 0
  ) {
    throw new AppError("Action I/O request expired before dispatch.", {
      statusCode: 408,
      code: "ACTION_IO_REQUEST_EXPIRED",
      details: { retryable: false, effects_possible: false },
    });
  }
};

/** Limits queue admission only; aborting this signal never cancels a process. */
export const actionIoQueueSignal = (
  command: BridgeCommand,
  timeoutMs: number,
  startedAt: number,
  callerSignal?: AbortSignal,
): AbortSignal | undefined => {
  if (!requiresActionIoCapability(command)) return callerSignal;
  const remaining = remainingActionIoWaitMs(command, timeoutMs, startedAt);
  const deadline =
    remaining === 0
      ? AbortSignal.abort(new Error("Action I/O queue deadline expired"))
      : AbortSignal.timeout(remaining);
  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
};

/** Bounds a validated read's transport wait; never changes business bytes or mutations. */
export const limitActionIoReadWait = (payload: unknown, remainingMs: number): unknown => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const command = payload as Record<string, unknown>;
  if (command.method !== "agent.action.readIo") return payload;
  const params = command.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return payload;
  const input = params as Record<string, unknown>;
  if (typeof input.wait_ms !== "number" || input.wait_ms === 0) return payload;
  const wait = Math.max(0, Math.min(20000, Math.floor(remainingMs) - 5000, input.wait_ms));
  return { ...command, params: { ...input, wait_ms: wait } };
};

/** Hub-owned request budget, applied only after capability validation. */
export const applyActionIoDeadline = (
  command: BridgeCommand,
  payload: unknown,
  remainingMs: number,
  now = Date.now(),
): unknown => {
  if (!requiresActionIoCapability(command)) return payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const bounded = limitActionIoReadWait(payload, remainingMs) as Record<string, unknown>;
  const remaining = Math.max(0, Math.min(30000, Math.floor(remainingMs)));
  const meta = bounded.meta;
  return {
    ...bounded,
    meta: {
      ...(meta !== null && typeof meta === "object" && !Array.isArray(meta) ? meta : {}),
      action_io_remaining_ms: remaining,
      action_io_deadline_unix_ms: now + remaining,
    },
  };
};
