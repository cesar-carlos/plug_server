import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { getPlugAgenteContractPaths } from "../helpers/plug_agente_contract";

vi.mock("dotenv", () => ({ default: { config: () => ({ parsed: {} }) } }));

const liveTest = process.env.RUN_NATIVE_DESKTOP_BOOTSTRAP === "true" ? it : it.skip;
liveTest(
  "should restore a configured native desktop profile and refresh its DPAPI session through the real hub",
  async () => {
    const agent = getPlugAgenteContractPaths();
    if (!agent || process.platform !== "win32")
      throw new Error("Explicit Windows agent checkout required");
    const root = await mkdtemp(join(tmpdir(), "sql-operation-bootstrap-"));
    const uploads = join(root, "uploads");
    await mkdir(uploads);
    vi.stubEnv("UPLOADS_DIR", uploads);
    vi.stubEnv("JWT_ACCESS_SECRET", randomUUID());
    vi.stubEnv("JWT_REFRESH_SECRET", randomUUID());
    const { registerHttpRateLimits } =
      await import("../../src/presentation/http/middlewares/rate_limit.middleware");
    registerHttpRateLimits();
    const { createTestServer } = await import("../helpers/test_server");
    const { registerOwnerSession } = await import("./helpers/client_sessions");
    const { seedAgent, seedAgentBinding } = await import("./helpers/seed_agent");
    const { agentRegistry } =
      await import("../../src/presentation/socket/hub/registries/agent_registry");
    const server = await createTestServer();
    const children: { child: ChildProcess; exited: Promise<number> }[] = [];
    let refreshRequests = 0;
    server.httpServer.on("request", (incoming) => {
      if (incoming.url?.includes("refresh")) refreshRequests++;
    });
    try {
      const owner = await registerOwnerSession(server.httpServer);
      const agentId = randomUUID();
      await seedAgent({
        agentId,
        name: "Private bootstrap fixture",
        tradeName: "Private bootstrap fixture",
        document: "52998224725",
        documentType: "cpf",
        mobile: "11988887777",
        email: "fixture@example.com",
        address: {
          street: "Fixture",
          number: "1",
          district: "Fixture",
          postalCode: "01001000",
          city: "Fixture",
          state: "SP",
        },
      });
      await seedAgentBinding(owner.userId, agentId);
      const login = await request(server.httpServer)
        .post("/api/v1/auth/agent-login")
        .send({ email: owner.email, password: owner.password, agentId });
      expect(login.status).toBe(200);
      const pair = z
        .object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) })
        .parse(login.body);
      await writeFile(
        join(root, "profile-bootstrap.json"),
        JSON.stringify({ serverUrl: server.getUrl(), agentId, ...pair }),
      );
      const toolchain = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|OS|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|ALLUSERSPROFILE|NUMBER_OF_PROCESSORS)$/i.test(
            key,
          ),
        ),
      );
      let previous: { configId: string; instanceId: string; sessionId: string } | undefined;
      for (const phase of ["cold", "restart"]) {
        await Promise.all(
          ["stop", "boot-ready.json", "boot-closed"].map((name) =>
            rm(join(root, name), { force: true }),
          ),
        );
        let output = "";
        const child = spawn(
          resolve(agent.root, "build/homologation/desktop-bootstrap/plug_agente.exe"),
          ["--installation-check"],
          {
            cwd: root,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...toolchain,
              PLUG_AGENT_BOOTSTRAP_ROOT: root,
              PLUG_AGENT_BOOTSTRAP_URL: server.getUrl(),
              PLUG_AGENT_BOOTSTRAP_PROFILE: "configured",
            },
          },
        );
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
        const deadline = Date.now() + 75000;
        let ready: unknown;
        while (ready === undefined || !agentRegistry.getProtocolReadiness(agentId).ready) {
          if (child.exitCode !== null)
            throw new Error(`Configured desktop exited with ${child.exitCode}: ${output}`);
          if (Date.now() > deadline) throw new Error(`Configured desktop ready timeout: ${output}`);
          try {
            ready = JSON.parse(await readFile(join(root, "boot-ready.json"), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await new Promise<void>((done) => setTimeout(done, 40));
        }
        const evidence = z
          .object({
            core: z.literal(true),
            firstFrame: z.literal(true),
            sqlOperationsDefault: z.literal(false),
            configCount: z.literal(1),
            configuredAutoSession: z.literal(true),
            secretRoundtrip: z.literal(true),
            databaseIntegrity: z.literal("ok"),
            configId: z.string().uuid(),
            instanceId: z.string(),
            sessionId: z.string(),
          })
          .parse(ready);
        expect(agentRegistry.findByAgentId(agentId)?.userId).toBe(owner.userId);
        expect(agentRegistry.getCapabilitiesByAgentId(agentId)).not.toMatchObject({
          extensions: { sqlOperations: { version: 1 } },
        });
        expect(refreshRequests).toBe(phase === "cold" ? 1 : 2);
        if (previous) {
          expect(evidence.configId).toBe(previous.configId);
          expect(evidence.instanceId).toBe(previous.instanceId);
          expect(evidence.sessionId).not.toBe(previous.sessionId);
        }
        previous = evidence;
        await writeFile(join(root, "stop"), "finish");
        expect(
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              const timer = setTimeout(
                () => reject(new Error("Configured native shutdown timed out")),
                15000,
              );
              timer.unref();
            }),
          ]),
        ).toBe(0);
        expect(await readFile(join(root, "boot-closed"), "utf8")).toBe("verified");
        await rm(join(root, "profile-bootstrap.json"), { force: true });
      }
    } finally {
      for (const tracked of children) {
        if (tracked.child.exitCode === null && tracked.child.pid !== undefined)
          spawnSync("taskkill", ["/pid", String(tracked.child.pid), "/t", "/f"], {
            windowsHide: true,
          });
        await tracked.exited;
      }
      await server.close();
      agentRegistry.clear();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  210000,
);
