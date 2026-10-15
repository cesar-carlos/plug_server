import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { Server } from "socket.io";
import { expect, it, vi } from "vitest";
import { getPlugAgenteContractPaths } from "../helpers/plug_agente_contract";
import { buildHubServerCapabilities } from "../../src/shared/constants/agent_transport_contract";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { bridgeSingleCommandSchema } from "../../src/shared/validators/agent_command";
import { createDispatchRpcCommandToAgent } from "../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_command";
import { createRpcBridgeAgentInboundHandlers } from "../../src/presentation/socket/hub/relay/rpc_bridge_agent_inbound";
import { createRpcBridgeRelayDispatch } from "../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_relay";
import { conversationRegistry } from "../../src/presentation/socket/hub/registries/conversation_registry";
import { resetRelayRequestRegistry } from "../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetRelayIdempotencyStore } from "../../src/presentation/socket/hub/registries/relay_idempotency_store";
import { agentRegistry } from "../../src/presentation/socket/hub/registries/agent_registry";
import { resetRestPendingRequestsStore } from "../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetBridgeCommandReplayGuard } from "../../src/application/agent_commands/bridge_command_replay_guard";

vi.mock("../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(async (): Promise<void> => undefined),
}));

const liveTest = process.env.RUN_DART_SQL_OPERATION_TRANSPORT === "true" ? it : it.skip;
liveTest(
  "Dart production socket negotiates operations and preserves the durable uncertain receipt",
  async () => {
    const agent = getPlugAgenteContractPaths();
    expect(agent).not.toBeNull();
    if (!agent) throw new Error("plug_agente checkout required");
    const server = createServer();
    const io = new Server(server, { transports: ["websocket"] });
    const namespace = io.of("/agents");
    namespace.use((socket, next) =>
      next(
        socket.handshake.auth.token === "test-only-token" ? undefined : new Error("unauthorized"),
      ),
    );
    const consumerWaiters = new Map<string, (response: unknown) => void>();
    const emitToConsumer = (_socket: string, _event: string, raw: unknown): boolean => {
      const decoded = decodePayloadFrame(raw);
      if (!decoded.ok) return false;
      const payload = decoded.value.data as { id?: string };
      if (payload.id !== undefined) consumerWaiters.get(payload.id)?.(payload);
      return true;
    };
    const relay = createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => namespace.sockets.get(id) ?? null,
      emitToConsumer,
      prepareAgentStreamPull: () => {
        throw new Error("Operation cannot stream");
      },
    });
    const inbound = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: () => undefined,
    });
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => namespace.sockets.get(id) ?? null,
    });
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const done = { promise: finished, resolve: resolveDone, reject: rejectDone };
    namespace.on("connection", (socket) => {
      socket.on(socketEvents.agentRegister, (raw: unknown) => {
        try {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok) throw decoded.error;
          const payload = decoded.value.data as {
            agentId: string;
            capabilities: Record<string, unknown>;
          };
          expect(payload.capabilities).toMatchObject({
            extensions: { sqlOperations: { version: 1, automaticReplay: false } },
          });
          agentRegistry.registerAgentSession({
            agentId: payload.agentId,
            socketId: socket.id,
            userId: "test-user",
            capabilities: payload.capabilities,
            policy: "legacy_silent_takeover",
            isPeerConnected: () => false,
          });
          socket.emit(
            socketEvents.agentCapabilities,
            encodePayloadFrame({ capabilities: buildHubServerCapabilities() }),
          );
        } catch (error) {
          done.reject(error);
        }
      });
      socket.once(socketEvents.agentReady, () => {
        agentRegistry.touch("agent-operation-test", {
          markProtocolReady: true,
          socketId: socket.id,
        });
        void (async () => {
          const reference = {
            contractVersion: 1,
            operationId: "00000000-0000-4000-8000-000000000001",
            fingerprint: "b".repeat(64),
            sourcePhysicalId: "c".repeat(64),
            database: "test_db",
            client_token: "token",
          };
          const plan = {
            ...reference,
            timeoutMs: 10000,
            maxAffectedRows: 2,
            steps: [
              {
                id: "insert_parent",
                effect: "insert",
                sql: "INSERT INTO parent(name) VALUES (:name) RETURNING id",
                params: { name: { kind: "value", scalar: { type: "string", value: "literal" } } },
                outputs: { id: "integer" },
                affectedRows: { min: 1, max: 1 },
              },
              {
                id: "insert_child",
                effect: "insert",
                sql: "INSERT INTO child(parent_id) VALUES (:parent_id) RETURNING id",
                params: {
                  parent_id: { kind: "step_output", stepId: "insert_parent", output: "id" },
                },
                outputs: {},
                affectedRows: { min: 1, max: 1 },
              },
            ],
          };
          let receipt: unknown;
          for (const [index, method] of [
            "sql.operation.execute",
            "sql.operation.get",
            "sql.operation.execute",
            "sql.operation.cancel",
          ].entries()) {
            const result = await dispatch({
              agentId: "agent-operation-test",
              timeoutMs: 15000,
              command: bridgeSingleCommandSchema.parse({
                jsonrpc: "2.0",
                id: String(index),
                method,
                params: method === "sql.operation.execute" ? plan : reference,
              }),
            });
            expect(result).toMatchObject({
              response: {
                id: String(index),
                result: {
                  operationId: reference.operationId,
                  fingerprint: reference.fingerprint,
                  state: "resultado_desconhecido",
                  directlyAffectedRows: null,
                },
              },
            });
            if ("response" in result) {
              const current = (result.response as { result: unknown }).result;
              if (receipt === undefined) receipt = current;
              else expect(current).toEqual(receipt);
            }
          }
          conversationRegistry.create({
            conversationId: "operation-conversation",
            consumerSocketId: "test-consumer",
            agentSocketId: socket.id,
            agentId: "agent-operation-test",
          });
          for (const [offset, method] of [
            "sql.operation.execute",
            "sql.operation.get",
            "sql.operation.execute",
            "sql.operation.cancel",
          ].entries()) {
            const id = String(offset + 4);
            const response = new Promise<unknown>((resolve) => consumerWaiters.set(id, resolve));
            await relay.dispatchRelayRpcToAgent({
              conversationId: "operation-conversation",
              consumerSocketId: "test-consumer",
              rawFramePayload: encodePayloadFrame({
                jsonrpc: "2.0",
                id,
                method,
                params: method === "sql.operation.execute" ? plan : reference,
              }),
              timeoutMs: 15000,
            });
            expect(await response).toMatchObject({ id, result: receipt });
          }
          done.resolve();
        })().catch(done.reject);
      });
      socket.on(socketEvents.rpcResponse, (raw: unknown, ack?: () => void) => {
        inbound.handleAgentRpcResponse(socket.id, raw, ack);
      });
      socket.emit(socketEvents.connectionReady, {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback listener unavailable");
    const fixture = join(
      agent.root,
      "test/infrastructure/external_services/sql_operation_socket_fixture_test.dart",
    );
    const flutter = process.env.FLUTTER_BIN ?? "flutter.bat";
    const child = spawn(
      process.platform === "win32" ? "cmd.exe" : flutter,
      process.platform === "win32"
        ? ["/d", "/s", "/c", flutter, "test", fixture, "--reporter", "compact"]
        : ["test", fixture, "--reporter", "compact"],
      {
        cwd: agent.root,
        env: { ...process.env, PLUG_SQL_OPERATION_E2E_URL: `http://127.0.0.1:${address.port}` },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? -1));
    });
    const timer = setTimeout(
      () => done.reject(new Error(`Isolated Dart socket test timed out: ${output}`)),
      45000,
    );
    try {
      await Promise.race([
        done.promise,
        exited.then((code) => {
          if (code !== 0) throw new Error(`Dart fixture failed (${code}): ${output}`);
          return done.promise;
        }),
      ]);
      expect(await exited, output).toBe(0);
    } finally {
      clearTimeout(timer);
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          const wait = setTimeout(() => resolve(false), 2000);
          wait.unref();
        }),
      ]);
      if (!stopped && child.pid !== undefined) {
        if (process.platform === "win32")
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
        else child.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => io.close(() => resolve()));
      agentRegistry.clear();
      conversationRegistry.clear();
      resetRestPendingRequestsStore();
      resetBridgeCommandReplayGuard();
      resetRelayRequestRegistry();
      resetRelayIdempotencyStore();
    }
  },
  60000,
);
