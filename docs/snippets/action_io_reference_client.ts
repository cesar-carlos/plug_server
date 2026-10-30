import { randomUUID } from "node:crypto";
import { bridgeCommandSchema } from "../../src/shared/validators/agent_command";
import { captureActionIoExpectation } from "../../src/shared/validators/action_io_response_expectation";
import { isValidActionIoResponse } from "../../src/shared/validators/action_io_result";
import { isRecord } from "../../src/shared/utils/rpc_types";
import { actionIoErrorDetails } from "../../src/shared/utils/action_io_error_details";

export interface ActionIoCommand {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}
/** Return the logical JSON-RPC envelope, after decoding the selected transport. */
export type ActionIoTransport = (command: ActionIoCommand) => Promise<unknown>;

export class ActionIoClientError extends Error {
  constructor(
    readonly code: string | number,
    readonly outcomeUnknown: boolean,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
    readonly rpcCode?: string | number,
  ) {
    super(`Remote action I/O failed (${code}); reconcile before any new mutation.`);
    this.name = "ActionIoClientError";
  }
}

/** No method retries. Keep keys, message IDs and cursors in caller-owned storage. */
export class ActionIoReferenceClient {
  constructor(
    private readonly transport: ActionIoTransport,
    private readonly credential: () => string,
  ) {}

  run(
    actionId: string,
    key: string,
    options: { initial?: Uint8Array; closeInput?: boolean; triggerId?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.call(
      "run",
      {
        action_id: actionId,
        idempotency_key: key,
        ...(options.triggerId === undefined ? {} : { trigger_id: options.triggerId }),
        io: {
          version: 1,
          mode: "faithful",
          close_input: options.closeInput ?? false,
          ...(options.initial === undefined
            ? {}
            : { initial_input_base64: Buffer.from(options.initial).toString("base64") }),
        },
      },
      true,
    );
  }

  sendInput(
    executionId: string,
    messageId: string,
    sequence: number,
    bytes: Uint8Array,
  ): Promise<Record<string, unknown>> {
    return this.call(
      "sendInput",
      {
        execution_id: executionId,
        message_id: messageId,
        sequence,
        data_base64: Buffer.from(bytes).toString("base64"),
      },
      true,
    );
  }
  closeInput(
    executionId: string,
    messageId: string,
    sequence: number,
  ): Promise<Record<string, unknown>> {
    return this.call(
      "closeInput",
      { execution_id: executionId, message_id: messageId, sequence },
      true,
    );
  }
  getInputStatus(executionId: string, messageId: string): Promise<Record<string, unknown>> {
    return this.call("getInputStatus", { execution_id: executionId, message_id: messageId });
  }
  findExecution(actionId: string, key: string): Promise<Record<string, unknown>> {
    return this.call("findExecution", { action_id: actionId, idempotency_key: key });
  }
  getExecution(executionId: string): Promise<Record<string, unknown>> {
    return this.call("getExecution", { execution_id: executionId });
  }
  /** Advance only after processing events; stop at completed, not at terminal alone. */
  readIo(
    executionId: string,
    afterSequence: number,
    waitMs = 20000,
  ): Promise<Record<string, unknown>> {
    return this.call("readIo", {
      execution_id: executionId,
      after_sequence: afterSequence,
      max_bytes: 262144,
      wait_ms: waitMs,
    });
  }

  private async call(
    operation: string,
    params: Record<string, unknown>,
    mutation = false,
  ): Promise<Record<string, unknown>> {
    const command: ActionIoCommand = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: `agent.action.${operation}`,
      params: { ...params, client_token: this.credential() },
    };
    if (!bridgeCommandSchema.safeParse(command).success)
      throw new ActionIoClientError("INVALID_REQUEST", false);
    let response: unknown;
    try {
      response = await this.transport(command);
    } catch (error: unknown) {
      if (error instanceof ActionIoClientError) throw error;
      throw new ActionIoClientError("TRANSPORT_UNCONFIRMED", mutation);
    }
    if (
      !isRecord(response) ||
      response.jsonrpc !== "2.0" ||
      response.id !== command.id ||
      !isValidActionIoResponse(command.method, response, {
        ...captureActionIoExpectation(command),
        faithfulIo: true,
      })
    ) {
      throw new ActionIoClientError("INVALID_RESPONSE", mutation);
    }
    if (isRecord(response.error)) {
      const code = response.error.code;
      const data = isRecord(response.error.data) ? response.error.data : undefined;
      const details = actionIoErrorDetails(data);
      throw new ActionIoClientError(
        typeof details.code === "string"
          ? details.code
          : typeof code === "string" || typeof code === "number"
            ? code
            : "REMOTE_ERROR",
        data?.effects_possible === true || (mutation && data?.effects_possible !== false),
        details,
        typeof code === "string" || typeof code === "number" ? code : undefined,
      );
    }
    if (!isRecord(response.result)) throw new ActionIoClientError("INVALID_RESPONSE", mutation);
    return response.result;
  }
}
