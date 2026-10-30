import { ActionIoClientError, type ActionIoTransport } from "./action_io_reference_client";
import { isRecord } from "../../src/shared/utils/rpc_types";
import { actionIoErrorDetails } from "../../src/shared/utils/action_io_error_details";

/** REST adapter for the existing normalized single-command bridge envelope. */
export const createRestActionIoTransport =
  (options: {
    readonly endpoint: string;
    readonly agentId: string;
    readonly bearerToken: () => string;
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
  }): ActionIoTransport =>
  async (command) => {
    const response = await (options.fetch ?? fetch)(options.endpoint, {
      method: "POST",
      redirect: "error",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.bearerToken()}`,
      },
      body: JSON.stringify({ agentId: options.agentId, command, timeoutMs: 30000 }),
    });
    // Allow bounded REST metadata around the negotiated 512 KiB logical response.
    const reader = response.body?.getReader();
    if (!reader) throw new ActionIoClientError("EMPTY_HTTP_RESPONSE", true);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 1024 * 1024) {
          let cleanupFailed = false;
          try {
            await reader.cancel();
          } catch {
            cleanupFailed = true;
          }
          throw new ActionIoClientError(
            "HTTP_RESPONSE_TOO_LARGE",
            true,
            cleanupFailed ? { cleanup_failed: true } : {},
          );
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !response.ok &&
      isRecord(body) &&
      body.success === false &&
      isRecord(body.error) &&
      typeof body.error.code === "string"
    ) {
      const details = actionIoErrorDetails({
        ...(isRecord(body.error.details) ? body.error.details : {}),
        ...(typeof body.requestId === "string" ? { request_id: body.requestId } : {}),
      });
      throw new ActionIoClientError(body.error.code, details.effects_possible !== false, details);
    }
    if (
      !isRecord(body) ||
      body.agentId !== options.agentId ||
      !isRecord(body.response) ||
      body.response.type !== "single" ||
      !isRecord(body.response.item)
    ) {
      throw new ActionIoClientError(`HTTP_${response.status}_INVALID_ENVELOPE`, true);
    }
    const item = body.response.item;
    const envelope = {
      jsonrpc: "2.0",
      id: item.id,
      ...(Object.hasOwn(item, "api_version") ? { api_version: item.api_version } : {}),
      ...(Object.hasOwn(item, "meta") ? { meta: item.meta } : {}),
    };
    if (
      item.success === true &&
      Object.hasOwn(item, "result") &&
      !Object.hasOwn(item, "error") &&
      response.ok
    ) {
      return { ...envelope, result: item.result };
    }
    if (item.success === false && isRecord(item.error) && !Object.hasOwn(item, "result")) {
      return { ...envelope, error: item.error };
    }
    throw new ActionIoClientError("INVALID_HTTP_RESULT", true);
  };
