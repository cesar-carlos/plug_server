import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
import { buildHubServerCapabilities } from "../../src/shared/constants/agent_transport_contract";
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
  const variants: (boolean | "odbc")[] =
    process.env.RUN_DART_PRODUCTION_TRANSPORT === "true" ? [false, true] : [false];
  if (process.env.RUN_DART_ODBC_TRANSPORT === "true") variants.push("odbc");
  socketTest.each(variants)(
    "preserves signed streams and row maps (production transport: %s)",
    async (production) => {
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
      let rowCount = 0;
      let gzipChunks = 0;
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
                const chunk = payload as { chunk_index: number; rows: unknown[] };
                expect(chunk).not.toHaveProperty("columnar");
                rowCount += chunk.rows.length;
                events.push(`chunk-${chunk.chunk_index}`);
                if (production) {
                  socket.emit(
                    socketEvents.rpcStreamPull,
                    encodePayloadFrame({
                      request_id: requestId,
                      stream_id: "production-stream",
                      window_size: 1,
                    }),
                  );
                }
              },
              onComplete: () => {
                events.push("complete");
                completeStream();
              },
            },
          });
          socket.emit(
            socketEvents.agentCapabilities,
            encodePayloadFrame({
              capabilities: buildHubServerCapabilities({
                recommendedStreamPullWindowSize: 12,
                maxStreamPullWindowSize: 32,
              }),
            }),
          );
          const dispatch = (): void => {
            socket.emit(
              socketEvents.rpcRequest,
              encodePayloadFrame(
                {
                  jsonrpc: "2.0",
                  id: requestId,
                  method: "sql.execute",
                  params: { sql: "SELECT 1" },
                },
                { requestId },
              ),
            );
          };
          if (production) socket.once(socketEvents.agentReady, dispatch);
          else dispatch();
        });
        socket.on(socketEvents.rpcResponse, (raw: unknown, ack?: () => void) => {
          handlers.handleAgentRpcResponse(socket.id, raw, ack);
        });
        socket.on(socketEvents.rpcChunk, (raw: unknown) => {
          if (decodePayloadFrame(raw).ok && (raw as { cmp?: string }).cmp === "gzip") gzipChunks++;
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
        production === "odbc"
          ? "tests/fixtures/socket/plug_agente_odbc_transport_test.dart"
          : production
            ? "tests/fixtures/socket/plug_agente_production_transport_test.dart"
            : "tests/fixtures/socket/plug_agente_live_bridge_test.dart",
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
          RPC_CHUNK_COLUMNAR_GZIP_ENABLED: "true",
          ODBC_STREAM_COLUMNAR_WIRE: "true",
          ODBC_STREAM_WIRE_ONLY: "true",
          PLUG_BRIDGE_E2E_ODBC: String(production === "odbc"),
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
        const chunks = production === "odbc" ? 1 : production ? 24 : 2;
        expect(events).toEqual([
          "register",
          "response",
          ...Array.from({ length: chunks }, (_, i) => `chunk-${i}`),
          "complete",
        ]);
        expect(rowCount).toBe(production === "odbc" ? 1 : production ? 1536 : 2);
        if (production === true) expect(gzipChunks).toBeGreaterThan(0);
        expect(await dartExit, dartOutput).toBe(0);
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        // Let Flutter release its native DLL before terminating its shell tree.
        const exited = await Promise.race([
          dartExit.then(() => true),
          delay(2000, false, { ref: false }),
        ]);
        if (!exited) {
          if (process.platform === "win32" && child.pid !== undefined) {
            const cleanup = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
              windowsHide: true,
            });
            await new Promise<void>((resolve) => {
              cleanup.on("error", () => resolve());
              cleanup.on("exit", () => resolve());
            });
          } else child.kill();
        }
        await new Promise<void>((resolve) => io.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
    45_000,
  );
});
