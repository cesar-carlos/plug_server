import type { BridgeCommand } from "../../shared/validators/agent_command";
import { AppError } from "../../shared/errors/app_error";

/** Shared across transports; long polls never consume control-command slots. */
export class ActionIoReadCapacity {
  private readonly readers = new Map<string, number>();

  public async acquire(input: {
    readonly command: BridgeCommand;
    readonly agentId: string;
    readonly signal: AbortSignal | undefined;
    readonly configuredLimit: number;
    readonly acquireControl: (signal: AbortSignal | undefined) => Promise<() => void>;
  }): Promise<() => void> {
    const command = input.command;
    if (
      Array.isArray(command) ||
      command.method !== "agent.action.readIo" ||
      typeof command.params?.wait_ms !== "number" ||
      command.params.wait_ms <= 0
    ) {
      return input.acquireControl(input.signal);
    }
    if (input.signal?.aborted) {
      throw new AppError("The read request was cancelled before dispatch.", {
        statusCode: 408,
        code: "ACTION_IO_REQUEST_EXPIRED",
        details: { retryable: false, effects_possible: false },
      });
    }
    const limit = Math.min(32, input.configuredLimit > 0 ? input.configuredLimit : 32);
    const active = this.readers.get(input.agentId) ?? 0;
    if (active >= limit) {
      throw new AppError("The agent has reached its concurrent I/O read limit.", {
        statusCode: 429,
        code: "ACTION_IO_READER_LIMIT",
        details: { retryable: false, effects_possible: false },
      });
    }
    this.readers.set(input.agentId, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.readers.get(input.agentId) ?? 1) - 1;
      if (remaining === 0) this.readers.delete(input.agentId);
      else this.readers.set(input.agentId, remaining);
    };
  }
}
