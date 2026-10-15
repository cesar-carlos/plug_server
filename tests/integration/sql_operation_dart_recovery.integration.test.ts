import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { getPlugAgenteContractPaths } from "../helpers/plug_agente_contract";
import { buildHubServerCapabilities } from "../../src/shared/constants/agent_transport_contract";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { bridgeSingleCommandSchema } from "../../src/shared/validators/agent_command";
import { createDispatchRpcCommandToAgent } from "../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_command";
import { createRpcBridgeAgentInboundHandlers } from "../../src/presentation/socket/hub/relay/rpc_bridge_agent_inbound";
import { cleanupPendingRequestsForAgentSocket } from "../../src/presentation/socket/hub/relay/rpc_bridge_lifecycle";
import { agentRegistry } from "../../src/presentation/socket/hub/registries/agent_registry";
import { resetRestPendingRequestsStore } from "../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetBridgeCommandReplayGuard } from "../../src/application/agent_commands/bridge_command_replay_guard";
import { createNativeCommitProxy } from "../helpers/native_commit_proxy";

vi.mock("../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(async (): Promise<void> => undefined),
}));
// This explicit fixture must never load the checkout's operational .env.
vi.mock("dotenv", () => ({ default: { config: () => ({ parsed: {} }) } }));

const liveTest = process.env.RUN_DART_SQL_OPERATION_TRANSPORT === "true" ? it : it.skip;
const nativeManifest = process.env.PLUG_SQL_OPERATION_NATIVE_MANIFEST;
const toolchainKeys = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "OS",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS",
  "FLUTTER_ROOT",
  "PUB_CACHE",
]);
const childToolchain = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => toolchainKeys.has(key.toUpperCase())),
);
if (nativeManifest && process.env.RUN_DART_SQL_OPERATION_TRANSPORT !== "true") {
  throw new Error(
    "Native recovery requires explicit RUN_DART_SQL_OPERATION_TRANSPORT=true; never skip a requested matrix.",
  );
}
interface RecoveryCase {
  label: string;
  engine?: string;
  stage?: string;
}
const cases: RecoveryCase[] = nativeManifest
  ? ["postgres", "mssql", "sybase"].flatMap((engine) =>
      ["before-commit", "after-commit", "in-flight-commit"].map((stage) => ({
        label: `${engine}/${stage}`,
        engine,
        stage,
      })),
    )
  : [{ label: "synthetic/pre-commit" }];
liveTest.each(cases)(
  "should recover $label through hub without replaying its durable claim",
  async ({ engine, stage }) => {
    const agent = getPlugAgenteContractPaths();
    if (!agent) throw new Error("Explicit agent checkout required");
    let database = "test_db";
    let nativePort: number | undefined;
    if (nativeManifest) {
      const manifest = z
        .object({
          runId: z.string().regex(/^se7e_persona_[a-f0-9]{12}_test$/),
          engines: z.object({
            postgres: z.object({
              database: z.string(),
              port: z.number().int().positive().max(65535),
            }),
            mssql: z.object({ database: z.string(), port: z.number().int().positive().max(65535) }),
            sybase: z.object({
              database: z.string(),
              port: z.number().int().positive().max(65535),
            }),
          }),
        })
        .parse(JSON.parse((await readFile(nativeManifest, "utf8")).replace(/^\uFEFF/, "")));
      for (const fixture of Object.values(manifest.engines))
        expect(fixture.database).toBe(manifest.runId);
      database = manifest.runId;
      nativePort = manifest.engines[engine as keyof typeof manifest.engines].port;
    }
    const root = await mkdtemp(join(tmpdir(), "sql-operation-recovery-"));
    const proxy =
      stage === "in-flight-commit" ? await createNativeCommitProxy(nativePort!) : undefined;
    const server = createServer();
    const io = new Server(server, { transports: ["websocket"] });
    const namespace = io.of("/agents");
    namespace.use((socket, next) =>
      next(
        socket.handshake.auth.token === "test-only-token" ? undefined : new Error("unauthorized"),
      ),
    );
    const inbound = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: () => false,
      emitRpcStreamPullForRoute: () => undefined,
    });
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => namespace.sockets.get(id) ?? null,
    });
    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: unknown) => void) | undefined;
    namespace.on("connection", (socket) => {
      socket.on(socketEvents.agentRegister, (raw: unknown) => {
        try {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok) throw decoded.error;
          const payload = decoded.value.data as {
            agentId: string;
            capabilities: Record<string, unknown>;
          };
          expect(payload.agentId).toBe("agent-operation-test");
          expect(payload.capabilities).toMatchObject({
            extensions: { sqlOperations: { version: 1, automaticReplay: false } },
          });
          agentRegistry.registerAgentSession({
            agentId: payload.agentId,
            socketId: socket.id,
            userId: "test-user",
            capabilities: payload.capabilities,
            policy: "legacy_silent_takeover",
            isPeerConnected: (id) => namespace.sockets.has(id),
          });
          socket.emit(
            socketEvents.agentCapabilities,
            encodePayloadFrame({ capabilities: buildHubServerCapabilities() }),
          );
        } catch (error) {
          readyReject?.(error);
        }
      });
      socket.once(socketEvents.agentReady, () => {
        agentRegistry.touch("agent-operation-test", {
          markProtocolReady: true,
          socketId: socket.id,
        });
        readyResolve?.();
      });
      socket.on(socketEvents.rpcResponse, (raw: unknown, ack?: () => void) =>
        inbound.handleAgentRpcResponse(socket.id, raw, ack),
      );
      socket.on("disconnect", () => cleanupPendingRequestsForAgentSocket(socket.id));
      socket.emit(socketEvents.connectionReady, {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback listener unavailable");
    const children: {
      child: ReturnType<typeof spawn>;
      exited: Promise<number>;
      output: () => string;
    }[] = [];
    const launch = (
      phase: "crash" | "recover",
    ): {
      child: ReturnType<typeof spawn>;
      exited: Promise<number>;
      output: () => string;
      ready: Promise<void>;
    } => {
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      const flutter = process.env.FLUTTER_BIN ?? "flutter.bat";
      const fixture = join(
        agent.root,
        "test/infrastructure/external_services/sql_operation_socket_fixture_test.dart",
      );
      const child = spawn(
        process.platform === "win32" ? "cmd.exe" : flutter,
        process.platform === "win32"
          ? ["/d", "/s", "/c", flutter, "test", fixture, "--reporter", "compact"]
          : ["test", fixture, "--reporter", "compact"],
        {
          cwd: agent.root,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...childToolchain,
            PLUG_SQL_OPERATION_NATIVE_MANIFEST: nativeManifest,
            PLUG_SQL_OPERATION_E2E_URL: `http://127.0.0.1:${address.port}`,
            PLUG_SQL_OPERATION_RECOVERY_ROOT: root,
            PLUG_SQL_OPERATION_RECOVERY_PHASE: phase,
            PLUG_SQL_OPERATION_NATIVE_ENGINE: engine,
            PLUG_SQL_OPERATION_NATIVE_STAGE: stage,
            PLUG_SQL_OPERATION_NATIVE_PROXY_PORT:
              phase === "crash" ? proxy?.port.toString() : undefined,
          },
        },
      );
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-16000);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-16000);
      });
      const exited = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? -1));
      });
      const tracked = { child, exited, output: () => output };
      children.push(tracked);
      return {
        ...tracked,
        ready: Promise.race([
          ready,
          exited.then(() => {
            throw new Error(`Agent exited before ready: ${output}`);
          }),
        ]),
      };
    };
    const reference = {
      contractVersion: 1,
      operationId: "00000000-0000-4000-8000-000000000001",
      fingerprint: "b".repeat(64),
      sourcePhysicalId: "c".repeat(64),
      database,
      client_token: "token",
    };
    const plan = {
      ...reference,
      timeoutMs: 10000,
      maxAffectedRows: 1,
      steps: [
        {
          id: "change",
          effect: "insert",
          sql: nativeManifest
            ? `INSERT INTO ${{ postgres: "public", mssql: "dbo", sybase: "DBA" }[engine as "postgres" | "mssql" | "sybase"]}.recovery_fixture(name) VALUES (:name)${engine === "postgres" ? " RETURNING name" : ""}`
            : "INSERT INTO parent(name) VALUES (:name) RETURNING id",
          params: { name: { kind: "value", scalar: { type: "string", value: "fixture" } } },
          outputs: {},
          affectedRows: { min: 1, max: 1 },
        },
      ],
    };
    const request = (method: string, id: string): ReturnType<typeof dispatch> =>
      dispatch({
        agentId: "agent-operation-test",
        timeoutMs: 10000,
        command: bridgeSingleCommandSchema.parse({
          jsonrpc: "2.0",
          id,
          method,
          params: method === "sql.operation.execute" ? plan : reference,
        }),
      });
    try {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const exercise = async (): Promise<void> => {
        const first = launch("crash");
        await first.ready;
        const interrupted = expect(
          request("sql.operation.execute", "interrupted"),
        ).rejects.toMatchObject({
          code: "SQL_OPERATION_OUTCOME_UNKNOWN",
          details: { retryable: false, outcome_unknown: true },
        });
        void interrupted.catch(() => undefined);
        if (proxy) {
          while (true) {
            try {
              await access(join(root, "commit-ready"));
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          proxy.arm();
          await writeFile(join(root, "commit-go"), "armed");
          await proxy.waitForCommitTraffic();
          await expect(access(join(root, "commit-returned"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          // Actual request and withheld server bytes prove the native call is pending.
          if (first.child.pid === undefined) throw new Error("Private agent process unavailable");
          if (process.platform === "win32") {
            const killed = spawnSync("taskkill", ["/pid", String(first.child.pid), "/t", "/f"], {
              windowsHide: true,
            });
            expect(killed.status).toBe(0);
          } else first.child.kill("SIGKILL");
          await writeFile(join(root, "interrupted-after-step"), stage!);
          await proxy.close();
        }
        await interrupted;
        expect(await first.exited).not.toBe(0);
        expect(await readFile(join(root, "interrupted-after-step"), "utf8")).toBe(
          stage ?? "durable-claim-before-commit",
        );
        const second = launch("recover");
        await second.ready;
        let receipt: unknown;
        for (const method of [
          "sql.operation.get",
          "sql.operation.execute",
          "sql.operation.cancel",
        ]) {
          const result = await request(method, `recovered-${method}`);
          expect(result).toMatchObject({
            response: {
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
        expect(await second.exited, second.output()).toBe(0);
        expect(await readFile(join(root, "recovered-without-replay"), "utf8")).toBe("verified");
        if (nativeManifest) {
          expect(
            JSON.parse(await readFile(join(root, "native-recovery-evidence.json"), "utf8")),
          ).toEqual({
            stage,
            rows: stage === "before-commit" ? 0 : 1,
            replayedTransactions: 0,
          });
        }
      };
      try {
        await Promise.race([
          exercise(),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error(
                    `Agent recovery timed out: ${children.map((tracked) => tracked.output()).join("\n")}`,
                  ),
                ),
              75000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      for (const process of children) {
        if (process.child.exitCode === null && process.child.pid !== undefined) {
          if (globalThis.process.platform === "win32")
            spawnSync("taskkill", ["/pid", String(process.child.pid), "/t", "/f"], {
              windowsHide: true,
            });
          else process.child.kill("SIGKILL");
        }
        await process.exited;
      }
      // close() is idempotent for the already interrupted proxy.
      if (proxy) await proxy.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      agentRegistry.clear();
      resetRestPendingRequestsStore();
      resetBridgeCommandReplayGuard();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  90000,
);
