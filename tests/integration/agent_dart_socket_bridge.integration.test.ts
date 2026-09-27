import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";

import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPlugAgenteContractPaths } from "../helpers/plug_agente_contract";
import {
  resetRestPendingRequestsStore,
  registerRestPendingRequest,
} from "../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetActiveStreamRegistry } from "../../src/presentation/socket/hub/registries/active_stream_registry";
import { createRpcBridgeAgentInboundHandlers } from "../../src/presentation/socket/hub/relay/rpc_bridge_agent_inbound";
import { resetAgentInboundSequencerForTests } from "../../src/presentation/socket/hub/relay/agent_inbound_sequencer";
import { resetAgentInboundIngressForTests } from "../../src/presentation/socket/hub/relay/agent_inbound_ingress_guard";
import { resetRelayRequestRegistry } from "../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetRelayOutboundQueueState } from "../../src/presentation/socket/hub/relay/relay_outbound_queue";
import { env } from "../../src/shared/config/env";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";

const agentContract = getPlugAgenteContractPaths();
const runDartE2e = process.env.RUN_DART_SOCKET_E2E === "true";
const socketTest = runDartE2e ? it : it.skip;

afterEach(() => {
  resetRestPendingRequestsStore();
  resetActiveStreamRegistry();
  resetRelayRequestRegistry();
  resetRelayOutboundQueueState();
  resetAgentInboundSequencerForTests();
  resetAgentInboundIngressForTests();
  vi.restoreAllMocks();
});

describe("Dart agent ↔ Node Socket.IO bridge", () => {
  socketTest(
    "preserves a signed gzip stream response, chunks and completion",
    async () => {
      expect(agentContract, "plug_agente checkout is required").not.toBeNull();
      if (agentContract === null) {
        return;
      }
      const signingKey = "bridge-test-key-not-for-production";
      const keyId = "bridge-test-key-1";
      const requestId = "req-dart-socket-bridge";
      vi.spyOn(env, "payloadSigningKey", "get").mockReturnValue(signingKey);
      vi.spyOn(env, "payloadSigningKeyId", "get").mockReturnValue(keyId);
      vi.spyOn(env, "payloadSigningPreviousKeys", "get").mockReturnValue({});
      vi.spyOn(env, "payloadSignOutbound", "get").mockReturnValue(false);
      vi.spyOn(env, "payloadFrameAsyncGunzipMinCompressedBytes", "get").mockReturnValue(1);

      const httpServer = createServer();
      const io = new Server(httpServer, { transports: ["websocket"] });
      const agents = io.of("/agents");
      agents.use((socket, next) => {
        next(
          socket.handshake.auth.token === "bridge-test-token"
            ? undefined
            : new Error("unauthorized"),
        );
      });
      const events: string[] = [];
      let completeStream!: () => void;
      let failStream!: (error: Error) => void;
      const streamDone = new Promise<void>((resolve, reject) => {
        completeStream = resolve;
        failStream = reject;
      });
      const handlers = createRpcBridgeAgentInboundHandlers({
        emitToConsumer: () => true,
        emitRpcStreamPullForRoute: () => undefined,
      });

      agents.on("connection", (socket) => {
        socket.on(socketEvents.agentRegister, (raw: unknown) => {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok) {
            failStream(decoded.error);
            return;
          }
          events.push("register");
          registerRestPendingRequest({
            primaryRequestId: requestId,
            correlationIds: [requestId],
            socketId: socket.id,
            agentId: "agent-dart-bridge-test",
            createdAtMs: Date.now(),
            resolve: () => {
              events.push("response");
            },
            reject: failStream,
            timeoutHandle: setTimeout(() => failStream(new Error("stream timed out")), 15_000),
            acked: false,
            streamHandlers: {
              consumerSocketId: "consumer-dart-bridge-test",
              onChunk: (payload) => {
                const chunk = payload as { chunk_index: number };
                events.push(`chunk-${chunk.chunk_index}`);
              },
              onComplete: () => {
                events.push("complete");
                completeStream();
              },
            },
          });
          socket.emit(socketEvents.agentCapabilities, encodePayloadFrame({ capabilities: {} }));
          socket.emit(
            socketEvents.rpcRequest,
            encodePayloadFrame(
              { jsonrpc: "2.0", id: requestId, method: "sql.execute", params: { sql: "SELECT 1" } },
              { requestId },
            ),
          );
        });
        socket.on(socketEvents.rpcResponse, (raw: unknown, ack?: () => void) => {
          handlers.handleAgentRpcResponse(socket.id, raw, ack);
        });
        socket.on(socketEvents.rpcChunk, (raw: unknown) => {
          handlers.handleAgentRpcChunk(socket.id, raw);
        });
        socket.on(socketEvents.rpcComplete, (raw: unknown) => {
          handlers.handleAgentRpcComplete(socket.id, raw);
        });
        socket.emit(socketEvents.connectionReady, {});
      });

      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const address = httpServer.address();
      expect(address && typeof address !== "string").toBe(true);
      if (!address || typeof address === "string") {
        return;
      }
      const testPath = path.join(
        process.cwd(),
        "tests/fixtures/socket/plug_agente_live_bridge_test.dart",
      );
      const args = ["test", testPath, "--reporter", "compact"];
      const flutterCommand = process.platform === "win32" ? "cmd.exe" : "flutter";
      const flutterArgs =
        process.platform === "win32" ? ["/d", "/s", "/c", "flutter.bat", ...args] : args;
      const child = spawn(flutterCommand, flutterArgs, {
        cwd: agentContract.root,
        env: {
          ...process.env,
          PLUG_BRIDGE_E2E_URL: `http://127.0.0.1:${address.port}`,
          PLUG_BRIDGE_E2E_REQUEST_ID: requestId,
          PLUG_BRIDGE_E2E_KEY: signingKey,
          PLUG_BRIDGE_E2E_KEY_ID: keyId,
        },
      });
      let dartOutput = "";
      child.stdout.on("data", (chunk: Buffer) => {
        dartOutput += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        dartOutput += chunk.toString("utf8");
      });
      const dartExit = new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? -1));
      });
      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          streamDone,
          dartExit.then((code) => {
            throw new Error(`Dart client exited before stream completion (${code}): ${dartOutput}`);
          }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(`Dart stream timed out: ${dartOutput}`)),
              20_000,
            );
          }),
        ]);
        expect(events).toEqual(["register", "response", "chunk-0", "chunk-1", "complete"]);
        expect(await dartExit, dartOutput).toBe(0);
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        child.kill();
        await new Promise<void>((resolve) => io.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
    45_000,
  );
});
