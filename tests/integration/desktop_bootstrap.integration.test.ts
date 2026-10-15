import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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

vi.mock("dotenv", () => ({ default: { config: () => ({ parsed: {} }) } }));
vi.mock("../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(async (): Promise<void> => undefined),
}));

const liveTest = process.env.RUN_NATIVE_DESKTOP_BOOTSTRAP === "true" ? it : it.skip;
liveTest(
  "should cold boot and restart the native AppInitializer, UI, DPAPI and production RPC in a private profile",
  async () => {
    const agent = getPlugAgenteContractPaths();
    if (!agent || process.platform !== "win32")
      throw new Error("Explicit Windows agent checkout required");
    const executable = resolve(agent.root, "build/homologation/desktop-bootstrap/plug_agente.exe");
    const root = await mkdtemp(join(tmpdir(), "sql-operation-bootstrap-"));
    const server = createServer();
    const io = new Server(server, { transports: ["websocket"] });
    const namespace = io.of("/agents");
    const token = randomUUID();
    const notificationId = `PlugDatabase.Homologacao.${randomUUID().replaceAll("-", "")}`;
    const notificationGuid = randomUUID();
    const notifications = process.env.RUN_NATIVE_WINDOWS_NOTIFICATIONS === "true";
    const inspect = process.env.RUN_NATIVE_DESKTOP_INSPECT === "true";
    namespace.use((socket, next) =>
      next(socket.handshake.auth.token === token ? undefined : new Error("unauthorized")),
    );
    const inbound = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: () => false,
      emitRpcStreamPullForRoute: () => undefined,
    });
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => namespace.sockets.get(id) ?? null,
    });
    let registerFailure: unknown;
    let protocolReady = false;
    namespace.on("connection", (socket) => {
      socket.on(socketEvents.agentRegister, (raw: unknown) => {
        try {
          const decoded = decodePayloadFrame(raw);
          if (!decoded.ok) throw decoded.error;
          const payload = z
            .object({
              agentId: z.literal("agent-bootstrap-test"),
              capabilities: z.record(z.string(), z.unknown()),
            })
            .parse(decoded.value.data);
          expect(payload.capabilities).not.toMatchObject({
            extensions: { sqlOperations: { version: 1 } },
          });
          agentRegistry.registerAgentSession({
            agentId: payload.agentId,
            socketId: socket.id,
            userId: "fixture-user",
            capabilities: payload.capabilities,
            policy: "legacy_silent_takeover",
            isPeerConnected: (id) => namespace.sockets.has(id),
          });
          socket.emit(
            socketEvents.agentCapabilities,
            encodePayloadFrame({ capabilities: buildHubServerCapabilities() }),
          );
        } catch (error) {
          registerFailure = error;
        }
      });
      socket.on(socketEvents.agentReady, () => {
        agentRegistry.touch("agent-bootstrap-test", {
          markProtocolReady: true,
          socketId: socket.id,
        });
        protocolReady = true;
      });
      socket.on(socketEvents.rpcResponse, (raw: unknown, ack?: () => void) =>
        inbound.handleAgentRpcResponse(socket.id, raw, ack),
      );
      socket.on("disconnect", () => cleanupPendingRequestsForAgentSocket(socket.id));
      socket.emit(socketEvents.connectionReady, {});
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Bootstrap listener unavailable");
    const toolchain = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|OS|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|ALLUSERSPROFILE|NUMBER_OF_PROCESSORS)$/i.test(
          key,
        ),
      ),
    );
    const children: { child: ChildProcess; exited: Promise<number> }[] = [];
    let previous: { instanceId: string; sessionId: string } | undefined;
    try {
      for (const phase of ["cold", "restart"]) {
        protocolReady = false;
        await rm(join(root, "stop"), { force: true });
        await rm(join(root, "boot-ready.json"), { force: true });
        await rm(join(root, "boot-closed"), { force: true });
        // Existing native check mode bypasses the installed instance's mutex;
        // the dedicated Dart target still runs AppInitializer and AppRoot.
        let output = "";
        const child = spawn(executable, ["--installation-check"], {
          cwd: root,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...toolchain,
            PLUG_AGENT_BOOTSTRAP_ROOT: root,
            PLUG_AGENT_BOOTSTRAP_URL: `http://127.0.0.1:${address.port}`,
            PLUG_AGENT_BOOTSTRAP_TOKEN: token,
            ...(notifications
              ? {
                  PLUG_AGENT_BOOTSTRAP_NOTIFICATION_ID: notificationId,
                  PLUG_AGENT_BOOTSTRAP_NOTIFICATION_GUID: notificationGuid,
                }
              : {}),
            ...(inspect && phase === "cold" ? { PLUG_AGENT_BOOTSTRAP_INSPECT: "true" } : {}),
          },
        });
        child.stdout?.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-16000);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-16000);
        });
        const exited = new Promise<number>((done, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => done(code ?? -1));
        });
        children.push({ child, exited });
        const deadline = Date.now() + 40000;
        let ready: unknown;
        while (ready === undefined || !protocolReady) {
          if (registerFailure) throw registerFailure;
          if (child.exitCode !== null)
            throw new Error(`Native bootstrap exited with ${child.exitCode}: ${output}`);
          if (Date.now() > deadline) throw new Error(`Native bootstrap ready timeout: ${output}`);
          try {
            ready = JSON.parse(await readFile(join(root, "boot-ready.json"), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await new Promise<void>((done) => setTimeout(done, 30));
        }
        const evidence = z
          .object({
            core: z.literal(true),
            firstFrame: z.literal(true),
            sqlOperationsDefault: z.literal(false),
            configCount: z.literal(0),
            secretRoundtrip: z.literal(true),
            databaseIntegrity: z.literal("ok"),
            runtime: z.string(),
            instanceId: z.string().startsWith("inst-"),
            sessionId: z.string().startsWith("sess-"),
          })
          .parse(ready);
        if (previous) {
          expect(evidence.instanceId).toBe(previous.instanceId);
          expect(evidence.sessionId).not.toBe(previous.sessionId);
        }
        previous = evidence;
        if (notifications) {
          expect(ready).toMatchObject({ notifications: true });
          const binding = spawnSync(
            "reg.exe",
            [
              "query",
              `HKCU\\Software\\Classes\\AppUserModelId\\${notificationId}`,
              "/v",
              "CustomActivator",
            ],
            { encoding: "utf8", windowsHide: true },
          );
          expect(binding.status).toBe(0);
          expect(binding.stdout.toLowerCase()).toContain(notificationGuid);
        }
        if (inspect && phase === "cold") {
          await writeFile(join(root, "inspect-ready"), "ready");
          const until = Date.now() + 25000;
          while (Date.now() < until) {
            try {
              await readFile(join(root, "inspect-complete"));
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            await new Promise<void>((done) => setTimeout(done, 50));
          }
        }
        const discovery = await dispatch({
          agentId: "agent-bootstrap-test",
          timeoutMs: 8000,
          command: bridgeSingleCommandSchema.parse({
            jsonrpc: "2.0",
            id: `boot-${phase}`,
            method: "rpc.discover",
            params: {},
          }),
        });
        expect(discovery).toMatchObject({ response: { result: { openrpc: expect.any(String) } } });
        await writeFile(join(root, "stop"), "finish");
        const status = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("Native shutdown timed out")), 15000);
            timer.unref();
          }),
        ]);
        expect(status).toBe(0);
        expect(await readFile(join(root, "boot-closed"), "utf8")).toBe("verified");
      }
    } finally {
      for (const tracked of children) {
        if (tracked.child.exitCode === null && tracked.child.pid !== undefined)
          spawnSync("taskkill", ["/pid", String(tracked.child.pid), "/t", "/f"], {
            windowsHide: true,
          });
        await tracked.exited;
      }
      await new Promise<void>((done) => io.close(() => done()));
      agentRegistry.clear();
      if (notifications) {
        for (const key of [
          `HKCU\\Software\\Classes\\AppUserModelId\\${notificationId}`,
          `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications\\Backup\\${notificationId}`,
          `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${notificationId}`,
        ]) {
          const present = spawnSync("reg.exe", ["query", key], { windowsHide: true });
          if (present.status === 0) {
            const deleted = spawnSync("reg.exe", ["delete", key, "/f"], { windowsHide: true });
            expect(deleted.status).toBe(0);
          }
        }
      }
      resetRestPendingRequestsStore();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  110000,
);
