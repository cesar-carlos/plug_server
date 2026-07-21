import type { Namespace } from "socket.io";
import type { Server as EngineServer } from "engine.io";

import {
  noteSocketEngineConnectionError,
  noteSocketNamespaceAdapterError,
  noteSocketNamespaceSocketError,
  type SocketEngineConnectionErrorCode,
} from "../../../shared/metrics/socket_hub_error.metrics";
import { logger } from "../../../shared/utils/logger";

type EngineConnectionErrorPayload = {
  readonly req?: unknown;
  readonly code?: number;
  readonly message?: string;
  readonly context?: {
    readonly name?: string;
    readonly protocol?: number;
    readonly error?: unknown;
  };
};

const resolveEngineConnectionErrorCode = (
  payload: EngineConnectionErrorPayload,
): SocketEngineConnectionErrorCode => {
  const contextName = payload.context?.name;
  if (contextName === "UNSUPPORTED_PROTOCOL_VERSION" || payload.context?.protocol !== undefined) {
    return "unsupported_protocol";
  }
  if (
    payload.code === 400 ||
    contextName === "ID_GENERATION_ERROR" ||
    contextName === "TRANSPORT_HANDSHAKE_ERROR"
  ) {
    return "bad_request";
  }
  return "unknown";
};

type RemovableEmitter = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const isRemovableEmitter = (value: unknown): value is RemovableEmitter =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { on?: unknown }).on === "function" &&
  typeof (value as { off?: unknown }).off === "function";

/**
 * Registers engine / adapter / per-socket error listeners and returns a disposer
 * that removes the long-lived listeners (safe to call from `closeSocketServer`
 * when tests create multiple socket servers in-process).
 */
export const registerSocketHubErrorHandlers = (
  engine: EngineServer,
  namespaces: readonly { readonly name: string; readonly namespace: Namespace }[],
): (() => void) => {
  const disposers: Array<() => void> = [];

  const onEngineConnectionError = (...args: unknown[]): void => {
    const payload = (args[0] ?? {}) as EngineConnectionErrorPayload;
    const code = resolveEngineConnectionErrorCode(payload);
    noteSocketEngineConnectionError(code);
    logger.warn("socket_engine_connection_error", {
      code,
      engineCode: payload.code ?? null,
      message: payload.message ?? null,
      contextName: payload.context?.name ?? null,
    });
  };

  (engine as unknown as RemovableEmitter).on("connection_error", onEngineConnectionError);
  disposers.push(() => {
    (engine as unknown as RemovableEmitter).off("connection_error", onEngineConnectionError);
  });

  for (const { name, namespace } of namespaces) {
    const adapter = namespace.adapter;
    if (isRemovableEmitter(adapter)) {
      const onAdapterError = (...args: unknown[]): void => {
        const error = args[0];
        noteSocketNamespaceAdapterError(name);
        logger.warn("socket_namespace_adapter_error", {
          namespace: name,
          message: error instanceof Error ? error.message : String(error),
        });
      };
      adapter.on("error", onAdapterError);
      disposers.push(() => {
        adapter.off("error", onAdapterError);
      });
    }

    const onNamespaceConnection = (...args: unknown[]): void => {
      const socket = args[0] as {
        id: string;
        on: (event: string, listener: (...listenerArgs: unknown[]) => void) => void;
      };
      socket.on("error", (...listenerArgs: unknown[]) => {
        const error = listenerArgs[0];
        noteSocketNamespaceSocketError(name);
        logger.warn("socket_namespace_socket_error", {
          namespace: name,
          socketId: socket.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };
    (namespace as unknown as RemovableEmitter).on("connection", onNamespaceConnection);
    disposers.push(() => {
      (namespace as unknown as RemovableEmitter).off("connection", onNamespaceConnection);
    });
  }

  return (): void => {
    for (const dispose of disposers) {
      dispose();
    }
  };
};
