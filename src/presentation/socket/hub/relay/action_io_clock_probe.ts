import { socketEvents } from "../../../../shared/constants/socket_events";
import { z } from "zod";
import type { BridgeCommand } from "../../../../shared/validators/agent_command";
import { AppError } from "../../../../shared/errors/app_error";
import { isRecord } from "../../../../shared/utils/rpc_types";
import { buildHubServerCapabilities } from "../../../../shared/constants/agent_transport_contract";
import { requiresActionIoDeadline } from "../../../../application/agent_commands/action_io_deadline";

export interface ActionIoClockBudget {
  readonly action_io_clock_id: string;
  readonly action_io_monotonic_deadline_ms: number;
}
export interface ActionIoClockSocket {
  timeout?: (ms: number) => { emitWithAck: (event: string, payload: unknown) => Promise<unknown> };
}
const clockSampleSchema = z.object({
  version: z.literal(1),
  clock_id: z.string().min(1).max(128),
  monotonic_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const failure = (): AppError =>
  new AppError("Action I/O deadline clock unavailable or request expired.", {
    statusCode: 408,
    code: "ACTION_IO_REQUEST_EXPIRED",
    details: { retryable: false, effects_possible: false },
  });

const boundedRemaining = (remaining: () => number): number => {
  const value = remaining();
  if (!Number.isFinite(value) || value < 1) throw failure();
  return Math.floor(Math.min(30000, value));
};

/** A fresh authenticated socket sample. Never cache across requests or reconnects. */
export const probeActionIoClock = async (
  command: BridgeCommand,
  capabilities: Record<string, unknown> | null,
  socket: ActionIoClockSocket,
  remaining: () => number,
  signal?: AbortSignal,
  hubExtensions = buildHubServerCapabilities().extensions,
): Promise<ActionIoClockBudget | undefined> => {
  const extensions = capabilities?.extensions;
  const actions = isRecord(extensions) ? extensions.agentActions : undefined;
  const hubActions = hubExtensions.agentActions;
  if (
    !requiresActionIoDeadline(command) ||
    !isRecord(actions) ||
    actions.deadlineClock !== 1 ||
    !isRecord(hubActions) ||
    hubActions.deadlineClock !== 1
  )
    return undefined;
  const wait = boundedRemaining(remaining);
  if (signal?.aborted || wait <= 0 || !socket.timeout) throw failure();
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(failure());
      signal?.addEventListener("abort", abort, { once: true });
    });
    const result = await Promise.race([
      socket.timeout(wait).emitWithAck(socketEvents.rpcClockProbe, { version: 1 }),
      cancelled,
    ]);
    const budget = boundedRemaining(remaining);
    const sample = clockSampleSchema.safeParse(result);
    if (
      signal?.aborted ||
      budget <= 0 ||
      !sample.success ||
      !Number.isSafeInteger(sample.data.monotonic_ms + budget)
    )
      throw failure();
    // Agent sampled BEFORE hub receipt: adding the remaining hub budget is
    // conservative by the return transit time. Later queues/encoding/transit
    // consume this fixed deadline, regardless of either machine's wall clock.
    return {
      action_io_clock_id: sample.data.clock_id,
      action_io_monotonic_deadline_ms: sample.data.monotonic_ms + budget,
    };
  } catch {
    throw failure(); // No fallback to wall-clock mode after negotiation.
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
};
