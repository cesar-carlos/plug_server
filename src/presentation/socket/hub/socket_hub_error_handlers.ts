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
  if (payload.code === 400 || contextName === "ID_GENERATION_ERROR" || contextName === "TRANSPORT_HANDSHAKE_ERROR") {
    return "bad_request";
  }
  return "unknown";
};

const isEventEmitterLike = (
  value: unknown,
): value is { on: (event: string, listener: (...args: unknown[]) => void) => void } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { on?: unknown }).on === "function";

export const registerSocketHubErrorHandlers = (
  engine: EngineServer,
  namespaces: readonly { readonly name: string; readonly namespace: Namespace }[],
): void => {
  engine.on("connection_error", (payload: EngineConnectionErrorPayload) => {
    const code = resolveEngineConnectionErrorCode(payload);
    noteSocketEngineConnectionError(code);
    logger.warn("socket_engine_connection_error", {
      code,
      engineCode: payload.code ?? null,
      message: payload.message ?? null,
      contextName: payload.context?.name ?? null,
    });
  });

  for (const { name, namespace } of namespaces) {
    const adapter = namespace.adapter;
    if (isEventEmitterLike(adapter)) {
      adapter.on("error", (error: unknown) => {
        noteSocketNamespaceAdapterError(name);
        logger.warn("socket_namespace_adapter_error", {
          namespace: name,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    namespace.on("connection", (socket) => {
      socket.on("error", (error: Error) => {
        noteSocketNamespaceSocketError(name);
        logger.warn("socket_namespace_socket_error", {
          namespace: name,
          socketId: socket.id,
          message: error.message,
        });
      });
    });
  }
};
