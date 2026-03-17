import type { Server as HttpServer } from "node:http";

import type { DefaultEventsMap } from "@socket.io/component-emitter";
import { Server, type Socket } from "socket.io";

import { authenticateSocket } from "./presentation/socket/auth/socket_auth.middleware";
import { agentRegistry } from "./presentation/socket/hub/agent_registry";
import {
  handleAgentBatchAck,
  handleAgentRpcAck,
  handleAgentRpcResponse,
  registerSocketBridgeServer,
} from "./presentation/socket/hub/rpc_bridge";
import { env } from "./shared/config/env";
import { socketEvents } from "./shared/constants/socket_events";
import type { JwtAccessPayload } from "./shared/utils/jwt";
import { logger } from "./shared/utils/logger";
import { decodePayloadFrame, encodePayloadFrame } from "./shared/utils/payload_frame";

type SocketData = {
  user?: JwtAccessPayload;
  agentId?: string;
  capabilities?: Record<string, unknown>;
};

type HubSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

const serverCapabilities = {
  protocols: ["jsonrpc-v2"],
  encodings: ["json"],
  compressions: ["gzip", "none"],
  extensions: {
    batchSupport: true,
    binaryPayload: true,
    compressionThreshold: 1024,
    maxInflationRatio: 20,
    signatureRequired: false,
    signatureScope: "transport-frame",
    signatureAlgorithms: [],
    streamingResults: false,
    plugProfile: "plug-jsonrpc-profile/2.4",
    orderedBatchResponses: true,
    notificationNullIdCompatibility: true,
    paginationModes: ["page-offset", "cursor-keyset"],
    traceContext: ["w3c-trace-context", "legacy-trace-id"],
    errorFormat: "structured-error-data",
    transportFrame: "payload-frame/1.0",
  },
  limits: {
    max_payload_bytes: 10 * 1024 * 1024,
    max_compressed_payload_bytes: 10 * 1024 * 1024,
    max_decoded_payload_bytes: 10 * 1024 * 1024,
    max_rows: 50000,
    max_batch_size: 32,
    max_concurrent_streams: 1,
    streaming_chunk_size: 500,
    streaming_row_threshold: 500,
  },
} as const;

const emitAppError = (socket: HubSocket, message: string): void => {
  socket.emit(socketEvents.appError, {
    message,
    code: "SOCKET_PROTOCOL_ERROR",
  });
};

const getUserId = (socket: HubSocket): string | null => {
  return typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const withOptionalRequestId = (requestId: string | undefined): { readonly requestId?: string } => {
  return requestId ? { requestId } : {};
};

export const createSocketServer = (httpServer: HttpServer): Server => {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin,
    },
  });

  io.use(authenticateSocket);
  registerSocketBridgeServer(io);

  io.on("connection", (socket: HubSocket) => {
    logger.info("Socket client connected", {
      socketId: socket.id,
      userId: getUserId(socket),
    });

    socket.emit(socketEvents.connectionReady, {
      id: socket.id,
      message: "Socket connected successfully",
      user: socket.data.user ?? null,
    });

    socket.on(socketEvents.agentRegister, (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        emitAppError(socket, decoded.error.message);
        return;
      }

      if (!isRecord(decoded.value.data)) {
        emitAppError(socket, "agent:register payload must be an object");
        return;
      }

      const { agentId, capabilities } = decoded.value.data;
      if (typeof agentId !== "string" || agentId.trim() === "" || !isRecord(capabilities)) {
        emitAppError(socket, "agent:register payload is missing required fields");
        return;
      }

      socket.data.agentId = agentId;
      socket.data.capabilities = capabilities;
      agentRegistry.upsert({
        agentId,
        socketId: socket.id,
        userId: getUserId(socket),
        capabilities,
      });

      logger.info("Agent registered on hub", {
        socketId: socket.id,
        agentId,
        userId: getUserId(socket),
      });

      socket.emit(
        socketEvents.agentCapabilities,
        encodePayloadFrame(
          {
            capabilities: serverCapabilities,
          },
          withOptionalRequestId(decoded.value.frame.requestId),
        ),
      );
    });

    socket.on(socketEvents.agentHeartbeat, (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        emitAppError(socket, decoded.error.message);
        return;
      }

      const currentAgentId =
        socket.data.agentId ??
        (isRecord(decoded.value.data) && typeof decoded.value.data.agent_id === "string"
          ? decoded.value.data.agent_id
          : undefined);

      if (!currentAgentId) {
        emitAppError(socket, "agent:heartbeat received before agent registration");
        return;
      }

      agentRegistry.touch(currentAgentId);

      socket.emit(
        socketEvents.hubHeartbeatAck,
        encodePayloadFrame(
          {
            agent_id: currentAgentId,
            timestamp: new Date().toISOString(),
            status: "ok",
          },
          withOptionalRequestId(decoded.value.frame.requestId),
        ),
      );
    });

    socket.on(socketEvents.rpcResponse, (rawPayload: unknown) => {
      handleAgentRpcResponse(socket.id, rawPayload);
    });

    socket.on(socketEvents.rpcRequestAck, (rawPayload: unknown) => {
      handleAgentRpcAck(socket.id, rawPayload);
    });

    socket.on(socketEvents.rpcBatchAck, (rawPayload: unknown) => {
      handleAgentBatchAck(socket.id, rawPayload);
    });

    socket.on("disconnect", () => {
      const removedAgent = agentRegistry.removeBySocketId(socket.id);
      if (removedAgent) {
        logger.info("Agent disconnected from hub", {
          socketId: socket.id,
          agentId: removedAgent.agentId,
          userId: removedAgent.userId,
        });
      }
    });
  });

  return io;
};
